/**
 * stdinCommands.js — line protocol on the backend's stdin, written by the Electron main process.
 *   "shutdown"                 graceful stop (unchanged)
 *   "setup-secret <value>"     per-launch setup-secret hand-off (utils/setupAuth.js) — consumed, never passed on or logged
 * Input is accumulated until a newline, so a command split across chunks is reassembled and a hand-off line can never be mistaken for
 * (or partially executed as) a shutdown. Only a line that is EXACTLY `shutdown` (after trimming) shuts down; a legacy unterminated
 * `shutdown` at the end of a chunk is still honoured. The buffer is capped; an over-long unterminated tail keeps only its end.
 */
const MAX_BUFFER = 4096;

function createStdinCommandParser({ handleHandoffLine, onShutdown }) {
  let buf = '';
  return function feed(chunk) {
    buf += String(chunk);
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();                                   // unfinished tail stays for the next chunk
    if (buf.trim() === 'shutdown') { lines.push('shutdown'); buf = ''; }
    for (const line of lines) {
      if (handleHandoffLine(line)) continue;
      if (line.trim() === 'shutdown') onShutdown();
    }
  };
}

module.exports = { createStdinCommandParser, MAX_BUFFER };
