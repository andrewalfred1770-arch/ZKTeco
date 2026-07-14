/**
 * zkChunkedAttendanceReader.js — Paced chunked reader for large ZK attendance buffers
 *
 * node-zklib's getAttendances() (zklibtcp.js readWithBuffer) fires ALL chunk
 * requests (CMD_DATA_RDY) for the attendance buffer in one unpaced loop, then
 * waits up to a hardcoded 10s for each packet. On large buffers (20k+ records
 * = many 64KB chunks) the embedded device controller cannot keep up, a >10s
 * gap triggers "TIME OUT !! N PACKETS REMAIN !", the read is abandoned via
 * CMD_FREE_DATA mid-stream, and the NEXT pass can start from a misaligned
 * device-side reply state — observed live as thousands of records decoding
 * with garbage timestamps that the quarantine system (correctly) rejects.
 *
 * This module replicates the same CMD_DATA_WRRQ → CMD_PREPARE_DATA/CMD_ACK_OK
 * → chunked CMD_DATA_RDY handshake, but requests one chunk at a time with a
 * configurable inter-chunk delay and per-chunk timeout/retry, giving the
 * device time to flush each chunk before the next is requested. Returns the
 * SAME { data, err } shape as getAttendances() so callers need no changes.
 *
 * Used ONLY for large buffers (see ZK_CHUNKED_READ_THRESHOLD) — small devices
 * keep using the original, already-certified zk.getAttendances() path.
 */

const {
  COMMANDS,
  REQUEST_DATA,
  MAX_CHUNK,
} = require('../../node_modules/node-zklib/constants');
const {
  createTCPHeader,
  decodeTCPHeader,
  decodeRecordData40,
  checkNotEventTCP,
} = require('../../node_modules/node-zklib/utils');

// Enable/disable the chunked reader entirely. Set to 'false' to revert to
// byte-for-byte original behavior (zk.getAttendances()) with zero code-path
// changes elsewhere.
const ZK_CHUNKED_READ_ENABLED = process.env.ZK_CHUNKED_READ_ENABLED !== 'false'; // default ON

// Buffers at/below this record count use the original zk.getAttendances()
// (already-certified small-device path, unchanged).
const ZK_CHUNKED_READ_THRESHOLD = parseInt(process.env.ZK_CHUNKED_READ_THRESHOLD || '5000', 10);

// Chunk size in bytes. MAX_CHUNK (65472) is the device protocol max for a
// single CMD_DATA packet; staying at/under it keeps framing assumptions
// identical to node-zklib's.
const ZK_CHUNK_SIZE = Math.min(parseInt(process.env.ZK_CHUNK_SIZE || String(MAX_CHUNK), 10), MAX_CHUNK);

// Delay between successive chunk requests — paces the device's reply queue.
const ZK_INTER_CHUNK_DELAY_MS = parseInt(process.env.ZK_INTER_CHUNK_DELAY_MS || '300', 10);

// Per-chunk inactivity timeout (scoped to ONE chunk, not the whole transfer —
// the original hardcoded 10000ms timer covered the entire multi-chunk read).
const ZK_CHUNK_TIMEOUT_MS = parseInt(process.env.ZK_CHUNK_TIMEOUT_MS || '8000', 10);

// Max re-sends of CMD_DATA_RDY for the SAME chunk before giving up on the
// whole read (resolves with whatever was assembled so far, plus err — same
// partial-result contract as getAttendances() today).
const ZK_MAX_CHUNK_RETRIES = parseInt(process.env.ZK_MAX_CHUNK_RETRIES || '2', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendChunkRequest(tcp, start, size) {
  tcp.replyId++;
  const reqData = Buffer.alloc(8);
  reqData.writeUInt32LE(start, 0);
  reqData.writeUInt32LE(size, 4);
  const buf = createTCPHeader(COMMANDS.CMD_DATA_RDY, tcp.sessionId, tcp.replyId, reqData);
  tcp.socket.write(buf, null, (err) => {
    if (err) log(`[ZK-CHUNK] sendChunkRequest write error: ${err.message}`);
  });
}

function log(logger, level, msg) {
  if (logger && typeof logger[level] === 'function') logger[level](msg);
}

/**
 * Read one CMD_DATA_RDY chunk (start, len bytes of payload, framed as
 * 8-byte mini-header + payload + 8 trailing bytes = len + 16 total on the
 * wire for full chunks, len + 8 for the final partial chunk — mirrors
 * readWithBuffer's `realTotalBuffer.length === MAX_CHUNK + 8` check).
 *
 * Resolves { buf: Buffer (payload only), err: null } on success, or
 * { buf: Buffer (partial/empty), err: Error } on timeout/close.
 */
function readOneChunk(tcp, start, len, expectedFramedLen, timeoutMs) {
  return new Promise((resolve) => {
    let totalBuffer = Buffer.from([]);
    let realTotalBuffer = Buffer.from([]);
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      tcp.socket.removeListener('data', onData);
      tcp.socket.removeListener('close', onClose);
    };

    const finish = (buf, err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ buf, err: err || null });
    };

    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(realTotalBuffer.length > 8 ? realTotalBuffer.subarray(8) : Buffer.from([]),
        new Error('TIME OUT !! 1 PACKETS REMAIN !')), timeoutMs);
    };

    const onData = (data) => {
      if (checkNotEventTCP(data)) return; // ignore stray realtime-event frames
      totalBuffer = Buffer.concat([totalBuffer, data]);
      if (totalBuffer.length < 8) { armTimer(); return; }
      const packetLength = totalBuffer.readUIntLE(4, 2);
      if (totalBuffer.length >= 8 + packetLength) {
        realTotalBuffer = Buffer.concat([realTotalBuffer, totalBuffer.subarray(16, 8 + packetLength)]);
        totalBuffer = totalBuffer.subarray(8 + packetLength);
        if (realTotalBuffer.length >= expectedFramedLen) {
          finish(realTotalBuffer.subarray(8, 8 + len), null);
          return;
        }
      }
      armTimer();
    };

    const onClose = () => finish(Buffer.from([]), new Error('Socket is disconnected unexpectedly'));

    tcp.socket.on('data', onData);
    tcp.socket.once('close', onClose);
    armTimer();
    sendChunkRequest(tcp, start, len);
  });
}

/**
 * Paced, chunked replacement for zk.getAttendances(). Reuses the existing
 * connected zk.zklibTcp socket/session — no new connection is opened.
 *
 * @param {object} zk - node-zklib instance (already connected)
 * @param {object} opts - { syncAttemptId, deviceId, deviceName }
 * @param {object} logger - winston-style logger (info/warn/error)
 * @returns {Promise<{ data: Array, err: Error|null }>}
 */
async function getAttendancesPaced(zk, opts = {}, logger = null) {
  const tcp = zk.zklibTcp;
  const { syncAttemptId, deviceId, deviceName } = opts;
  const tag = `device=${deviceId} "${deviceName}" syncAttemptId=${syncAttemptId}`;

  try {
    await tcp.freeData();
  } catch (err) {
    return { data: [], err };
  }

  tcp.replyId++;
  const reqBuf = createTCPHeader(COMMANDS.CMD_DATA_WRRQ, tcp.sessionId, tcp.replyId, REQUEST_DATA.GET_ATTENDANCE_LOGS);

  // Send the initial request and wait for CMD_PREPARE_DATA/CMD_ACK_OK (which
  // carries the total size) or an immediate CMD_DATA (small buffer, single
  // packet, no chunking needed).
  const initial = await new Promise((resolve) => {
    let settled = false;
    let timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      tcp.socket.removeListener('data', onData);
      resolve({ err: new Error('TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA') });
    }, ZK_CHUNK_TIMEOUT_MS);

    const onData = (data) => {
      if (checkNotEventTCP(data)) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tcp.socket.removeListener('data', onData);
      resolve({ reply: data });
    };

    tcp.socket.on('data', onData);
    tcp.socket.write(reqBuf, null, (err) => {
      if (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tcp.socket.removeListener('data', onData);
        resolve({ err });
      }
    });
  });

  if (initial.err) {
    return { data: [], err: initial.err };
  }

  const header = decodeTCPHeader(initial.reply.subarray(0, 16));

  if (header.commandId === COMMANDS.CMD_DATA) {
    // Small buffer — entire payload arrived in the initial reply.
    const records = decodeRecords(initial.reply.subarray(16 + 4), tcp.ip, null);
    log(logger, 'info', `[SYNC-CONVERGED] ${tag} mode=single-packet records=${records.length}`);
    try { await tcp.freeData(); } catch {}
    return { data: records, err: null };
  }

  if (header.commandId !== COMMANDS.CMD_ACK_OK && header.commandId !== COMMANDS.CMD_PREPARE_DATA) {
    return { data: [], err: new Error(`ERROR_IN_UNHANDLE_CMD ${header.commandId}`) };
  }

  const recvData = initial.reply.subarray(16);
  const size = recvData.readUIntLE(1, 4);

  const remain = size % ZK_CHUNK_SIZE;
  const numberChunks = (size - remain) / ZK_CHUNK_SIZE;
  const totalPackets = numberChunks + (remain > 0 ? 1 : 0);

  log(logger, 'info', `[SYNC-CHUNK] ${tag} total=${totalPackets} size=${size} chunkSize=${ZK_CHUNK_SIZE} interChunkDelayMs=${ZK_INTER_CHUNK_DELAY_MS}`);

  let payload = Buffer.from([]);
  let err = null;

  for (let i = 0; i <= numberChunks; i++) {
    const start = i * ZK_CHUNK_SIZE;
    const len = (i === numberChunks) ? remain : ZK_CHUNK_SIZE;
    if (len === 0) break; // exact multiple — no trailing partial chunk

    const chunkIndex = i + 1;
    const expectedFramedLen = len + 8;

    let chunkResult = null;
    for (let attempt = 0; attempt <= ZK_MAX_CHUNK_RETRIES; attempt++) {
      log(logger, 'info', `[SYNC-CHUNK] ${tag} chunk=${chunkIndex}/${totalPackets} start=${start} len=${len} attempt=${attempt + 1}`);
      chunkResult = await readOneChunk(tcp, start, len, expectedFramedLen, ZK_CHUNK_TIMEOUT_MS);
      if (!chunkResult.err) break;
      if (attempt < ZK_MAX_CHUNK_RETRIES) {
        log(logger, 'warn', `[SYNC-RETRY] ${tag} chunk=${chunkIndex}/${totalPackets} attempt=${attempt + 1} reason="${chunkResult.err.message}"`);
        await sleep(ZK_INTER_CHUNK_DELAY_MS);
      }
    }

    if (chunkResult.err) {
      log(logger, 'warn', `[SYNC-TIMEOUT] ${tag} chunk=${chunkIndex}/${totalPackets} bytesSoFar=${payload.length} totalSize=${size} reason="${chunkResult.err.message}"`);
      payload = Buffer.concat([payload, chunkResult.buf]);
      err = new Error(`TIME OUT !! ${totalPackets - chunkIndex + 1} PACKETS REMAIN !`);
      break;
    }

    payload = Buffer.concat([payload, chunkResult.buf]);

    if (i < numberChunks) await sleep(ZK_INTER_CHUNK_DELAY_MS);
  }

  try { await tcp.freeData(); } catch {}

  const records = decodeRecords(payload, tcp.ip, ZK_CHUNK_SIZE);

  if (!err) {
    log(logger, 'info', `[SYNC-CONVERGED] ${tag} mode=chunked records=${records.length} bytes=${payload.length}/${size}`);
  }

  return { data: records, err };
}

/**
 * Decode a raw attendance payload (post subarray(4) header skip) into
 * 40-byte records, attaching forensic _diag (chunkId/offset) when
 * chunkSize is known (chunked mode only — absent for single-packet mode).
 */
function decodeRecords(payload, ip, chunkSize) {
  const RECORD_PACKET_SIZE = 40;
  let recordData = payload.subarray(4);
  const records = [];
  let offset = 0;
  while (recordData.length >= RECORD_PACKET_SIZE) {
    const record = decodeRecordData40(recordData.subarray(0, RECORD_PACKET_SIZE));
    record.ip = ip;
    if (chunkSize) {
      record._diag = {
        chunkId: Math.floor(offset / chunkSize) + 1,
        offsetInChunk: offset % chunkSize,
      };
    }
    records.push(record);
    recordData = recordData.subarray(RECORD_PACKET_SIZE);
    offset += RECORD_PACKET_SIZE;
  }
  return records;
}

module.exports = {
  getAttendancesPaced,
  ZK_CHUNKED_READ_ENABLED,
  ZK_CHUNKED_READ_THRESHOLD,
};
