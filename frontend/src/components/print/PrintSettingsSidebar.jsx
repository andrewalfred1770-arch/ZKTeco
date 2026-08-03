/**
 * PrintSettingsSidebar — the left rail of the Print workspace.
 * Every control here is a REAL, wired print-experience setting (see the
 * `settings` shape in PrintPreviewModal.jsx and the matching optional
 * parameters `buildReportHTML` now accepts in reportTemplate.js) — nothing
 * here is decorative. Grouped the way Word/Acrobat group theirs: page setup,
 * then document chrome, then finishing touches.
 */
import React from 'react';
import { Printer as PrinterIcon } from 'lucide-react';

function Section({ title, children }) {
  return (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
      <p style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 10 }}>{title}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <label style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  );
}

const selectStyle = { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', minWidth: 110 };

function Segmented({ value, options, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 2 }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} title={o.label} style={{
          flex: 1, border: 'none', borderRadius: 6, cursor: 'pointer', padding: '5px 8px', fontSize: 11.5, fontWeight: 600,
          background: value === o.value ? 'var(--surface)' : 'transparent',
          color: value === o.value ? 'var(--accent)' : 'var(--text-3)',
          boxShadow: value === o.value ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
        }}>{o.icon || o.label}</button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)} role="switch" aria-checked={checked} style={{
      width: 34, height: 20, borderRadius: 99, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0,
      background: checked ? 'var(--accent)' : 'var(--border)', transition: 'background 0.15s',
    }}>
      <span style={{
        position: 'absolute', top: 2, insetInlineStart: checked ? 16 : 2, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'inset-inline-start 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
      }} />
    </button>
  );
}

export default function PrintSettingsSidebar({ settings, onChange, orientation, onOrientationChange, hasStamp }) {
  const set = (patch) => onChange({ ...settings, ...patch });

  return (
    <div style={{ width: 232, flexShrink: 0, borderInlineEnd: '1px solid var(--border)', background: 'var(--surface)', overflowY: 'auto' }}>
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' }}>
        <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 7 }}>
          <PrinterIcon style={{ width: 14, height: 14 }} /> إعدادات الطباعة
        </p>
      </div>

      <Section title="الصفحة">
        <Row label="الطابعة">
          <span title="يتم اختيار الطابعة الفعلية عند الطباعة" style={{ fontSize: 11, color: 'var(--text-3)' }}>افتراضي النظام</span>
        </Row>
        <Row label="حجم الورق">
          <select style={selectStyle} value={settings.paperSize} onChange={e => set({ paperSize: e.target.value })}>
            <option value="A4">A4</option>
            <option value="Letter">Letter</option>
            <option value="Legal">Legal</option>
          </select>
        </Row>
        <Row label="الاتجاه">
          <Segmented value={orientation} onChange={onOrientationChange} options={[
            { value: 'portrait', label: 'عمودي' },
            { value: 'landscape', label: 'أفقي' },
          ]} />
        </Row>
        <Row label="الهوامش">
          <select style={selectStyle} value={settings.margins} onChange={e => set({ margins: e.target.value })}>
            <option value="narrow">ضيقة</option>
            <option value="normal">عادية</option>
            <option value="wide">واسعة</option>
          </select>
        </Row>
        <Row label="المقياس">
          <select style={selectStyle} value={settings.scalePercent} onChange={e => set({ scalePercent: Number(e.target.value) })}>
            {[85, 90, 100, 110, 125].map(v => <option key={v} value={v}>{v}%</option>)}
          </select>
        </Row>
      </Section>

      <Section title="محتوى المستند">
        <Row label="رأس وتذييل الصفحة"><Toggle checked={settings.showHeaderFooter} onChange={v => set({ showHeaderFooter: v })} /></Row>
        <Row label="تكرار رأس الجدول"><Toggle checked={settings.repeatHeader} onChange={v => set({ repeatHeader: v })} /></Row>
        <Row label="طباعة الألوان والخلفيات"><Toggle checked={settings.printBackground} onChange={v => set({ printBackground: v })} /></Row>
        <Row label="منطقة التوقيع"><Toggle checked={settings.showSignatures} onChange={v => set({ showSignatures: v })} /></Row>
      </Section>

      <Section title="اللمسات الأخيرة">
        <Row label="العلامة المائية"><Toggle checked={settings.watermarkEnabled} onChange={v => set({ watermarkEnabled: v })} /></Row>
        {settings.watermarkEnabled && (
          <input value={settings.watermarkText} onChange={e => set({ watermarkText: e.target.value })}
            placeholder="نص العلامة المائية" style={{ ...selectStyle, width: '100%', minWidth: 0 }} />
        )}
        <Row label="ختم الشركة">
          <Toggle checked={settings.showStamp} onChange={v => set({ showStamp: v })} />
        </Row>
        {settings.showStamp && !hasStamp && (
          <p style={{ fontSize: 10.5, color: 'var(--text-3)' }}>لم يتم رفع ختم الشركة بعد — بيانات الشركة ← الشعار والصور</p>
        )}
        <Row label="عدد النسخ">
          <input type="number" min={1} max={99} value={settings.copies}
            onChange={e => set({ copies: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
            style={{ ...selectStyle, minWidth: 60, textAlign: 'center' }} />
        </Row>
      </Section>
    </div>
  );
}
