/**
 * DeviceMonitoringPanel — small, focused presentation pieces for the
 * Dashboard's device/fingerprint cards (Device Status, Device Monitoring
 * table, Fingerprint Statistics, Latest Fingerprints table).
 *
 * Presentation only — every number rendered here comes from data the caller
 * already fetched from existing endpoints (devices, recent attendance logs,
 * recent sync logs) or from the live useFingerprintSyncWorkflow socket state
 * the Dashboard already drives for the sync modal. No new backend behavior,
 * no fabricated or approximated numbers: fields that aren't available from
 * the current API (device firmware version, device-reported clock, and the
 * count of fingerprints enrolled-but-not-yet-imported on the device — the ZK
 * protocol layer this app talks to doesn't expose that count) are shown as
 * "unavailable" rather than invented or filled in from an unrelated metric.
 */
import React from 'react';
import {
  WifiOff, Fingerprint, Database, XCircle, HelpCircle, Loader2,
} from 'lucide-react';
import Badge from './ui/Badge';

const W = (v) => Number(v ?? 0).toLocaleString('en-US');

// 24-hour HH:MM only, deliberately not the app-wide fmtTime() 12h/AM-PM
// formatter — this column is spec'd narrower (22% width, single line) and
// dropping the AM/PM marker is what makes that fit.
function fmt24h(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export const DEVICE_STATUS_TONE = {
  online:  { color: 'var(--status-present)', bg: 'var(--status-present-bg)', label: 'متصل',     badgeTone: 'green' },
  syncing: { color: 'var(--accent)',         bg: 'var(--accent-soft)',       label: 'مزامنة',    badgeTone: 'blue'  },
  error:   { color: 'var(--status-absent)',  bg: 'var(--status-absent-bg)',  label: 'خطأ',       badgeTone: 'red'   },
  offline: { color: 'var(--status-absent)',  bg: 'var(--status-absent-bg)',  label: 'غير متصل', badgeTone: 'gray'  },
};

function fmtAgo(isoDate) {
  if (!isoDate) return 'لم تتم بعد';
  const secs = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (secs < 60) return `منذ ${W(secs)} ث`;
  if (secs < 3600) return `منذ ${W(Math.floor(secs / 60))} د`;
  if (secs < 86400) return `منذ ${W(Math.floor(secs / 3600))} س`;
  return `منذ ${W(Math.floor(secs / 86400))} يوم`;
}

function StatusDot({ tone }) {
  return (
    <span style={{
      display: 'inline-block', width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
      background: tone.color,
      boxShadow: tone.label === 'متصل' || tone.label === 'مزامنة' ? `0 0 5px ${tone.color}` : 'none',
    }} />
  );
}

function EmptyRow({ icon: Icon, text }) {
  return (
    <div style={{ textAlign: 'center', padding: '14px 0', color: 'var(--text-3)' }}>
      {Icon && <Icon style={{ width: 18, height: 18, margin: '0 auto 4px', color: 'var(--text-3)' }} />}
      <p style={{ fontSize: 'var(--text-xs)' }}>{text}</p>
    </div>
  );
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/* ── Card 2 (left column): Device Status — very compact ─────────────────── */
export function DeviceStatusCompact({ devices = [], liveSyncing = false }) {
  if (devices.length === 0) return <EmptyRow icon={WifiOff} text="لا توجد أجهزة مضافة" />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {devices.map((d) => {
        const tone = DEVICE_STATUS_TONE[d.status] || DEVICE_STATUS_TONE.offline;
        const state = liveSyncing ? 'مزامنة جارية'
          : d.status === 'online' ? 'جاهز'
          : d.status === 'syncing' ? 'مزامنة جارية'
          : d.status === 'error' ? 'خطأ'
          : 'خامل';
        return (
          <div key={d.id} style={{
            padding: '10px 12px', borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusDot tone={tone} />
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', flex: 1, minWidth: 0, ...ellipsis }}>{d.name}</span>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: tone.color }}>{tone.label}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, fontSize: 13, color: 'var(--text-3)' }}>
              <span style={{ fontFamily: 'Consolas, monospace', minWidth: 0, ...ellipsis }}>{d.ipAddress}</span>
              <span style={{ marginInlineStart: 'auto', whiteSpace: 'nowrap' }}>{fmtAgo(d.lastSync)}</span>
              <span style={{ fontWeight: 700, color: liveSyncing ? 'var(--accent)' : 'var(--text-3)', whiteSpace: 'nowrap' }}>{state}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Card 3 (left column): Device Monitoring — compact table ────────────── */
export function DeviceMonitoringTable({ devices = [] }) {
  if (devices.length === 0) return <EmptyRow icon={WifiOff} text="لا توجد أجهزة مضافة" />;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th style={{ width: 66 }}>الحالة</th>
          <th>الجهاز</th>
          <th>IP</th>
          <th style={{ width: 88 }}>آخر مزامنة</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => {
          const tone = DEVICE_STATUS_TONE[d.status] || DEVICE_STATUS_TONE.offline;
          return (
            <tr key={d.id}>
              <td><Badge tone={tone.badgeTone}>{tone.label}</Badge></td>
              <td style={{ fontWeight: 600, maxWidth: 110, ...ellipsis }}>{d.name}</td>
              <td className="num" style={{ color: 'var(--text-2)' }}>{d.ipAddress}</td>
              <td className="num" style={{ color: 'var(--text-3)' }}>{fmtAgo(d.lastSync)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ── Right-inside column, top card: Fingerprint Statistics ────────────────
   Font-metric independence: a browser's DEFAULT line-height is a per-font
   multiplier (Segoe UI, SF Pro and Inter don't agree on it), so three lines
   of text at identical font-sizes can render several px taller or shorter
   purely from a font swap — with no explicit line-height, that drift shows
   up as the whole tile (and its grid row) changing height. Pinning an
   explicit, relative line-height on every text line removes that variable;
   minHeight is just the belt-and-suspenders floor underneath it. */
function MiniKpi({ icon: Icon, label, value, tone, sub }) {
  const color = tone?.color || 'var(--text)';
  const bg = tone?.bg || 'var(--surface-2)';
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 'var(--radius)', minHeight: sub ? 112 : 76,
      background: bg, border: `1px solid ${tone ? color + '30' : 'var(--border)'}`,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: tone ? color : 'var(--text-3)' }}>
        <Icon style={{ width: 14, height: 14, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.3, ...ellipsis }}>{label}</span>
      </div>
      <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.2, color, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      {sub && <span style={{ fontSize: 11.5, lineHeight: 1.3, color: 'var(--text-3)' }}>{sub}</span>}
    </div>
  );
}

export function FingerprintStatsGrid({ totalLogs = 0, importedToday = 0, failedToday = 0 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
      <MiniKpi icon={Database} label="إجمالي البصمات" value={W(totalLogs)} />
      {/* The device protocol layer this app uses doesn't report a count of
          fingerprints enrolled on the device but not yet imported — shown
          honestly as unavailable rather than approximated from an unrelated
          metric. */}
      <MiniKpi
        icon={HelpCircle}
        label="بصمات جديدة بانتظار الاستيراد"
        value="غير مدعوم"
        tone={{ color: 'var(--text-3)', bg: 'var(--surface-2)' }}
        sub="غير متاح من الجهاز"
      />
      <MiniKpi icon={Fingerprint} label="مستوردة اليوم" value={W(importedToday)} tone={{ color: 'var(--status-present)', bg: 'var(--status-present-bg)' }} />
      <MiniKpi
        icon={failedToday > 0 ? XCircle : Loader2}
        label="فشلت اليوم"
        value={W(failedToday)}
        tone={failedToday > 0 ? { color: 'var(--status-absent)', bg: 'var(--status-absent-bg)' } : undefined}
      />
    </div>
  );
}

/* ── Right-inside column, bottom card: Latest 10 Fingerprints ─────────────
   Device dropped deliberately — the dedicated Device Monitoring card (Card 3,
   left column) already shows it; repeating it here just ate into the width
   the employee name needs. Only Employee / Time / Type remain, weighted
   60/22/18 via a fixed table layout so the ratio actually holds regardless
   of content length. Row padding uses the existing --space-3/--space-4
   tokens (12px/16px) — no new spacing scale — landing at ~44-48px rows. */
export function LatestFingerprintsTable({ events = [] }) {
  if (events.length === 0) return <EmptyRow text="لا توجد بصمات حديثة" />;
  const cellPad = { padding: 'var(--space-3) var(--space-4)' };
  return (
    <table className="data-table" style={{ tableLayout: 'fixed' }}>
      <thead>
        <tr>
          <th style={{ width: '60%', ...cellPad }}>الموظف</th>
          <th style={{ width: '22%', ...cellPad }}>الوقت</th>
          <th style={{ width: '18%', ...cellPad }}>النوع</th>
        </tr>
      </thead>
      <tbody>
        {events.map((ev) => (
          <tr key={ev.id}>
            {/* Employee — an English name inside this RTL table must be laid
                out as its own LTR run so it doesn't get visually reversed,
                and truncation must eat the END of the name ("Fady Saf…"),
                which requires text-align:left even though the table itself
                is RTL — a right-aligned ellipsis would instead eat the
                start ("…dy Safwat"). */}
            <td style={{
              ...cellPad, fontWeight: 700, color: 'var(--c-name)',
              direction: 'ltr', unicodeBidi: 'plaintext', textAlign: 'left',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {ev.employeeName}
            </td>
            <td className="num" style={{ ...cellPad, color: 'var(--c-time)', whiteSpace: 'nowrap' }}>
              {fmt24h(ev.timestamp)}
            </td>
            <td style={cellPad}>
              <Badge tone={ev.isManual ? 'purple' : 'blue'}>{ev.isManual ? 'يدوي' : 'بصمة'}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
