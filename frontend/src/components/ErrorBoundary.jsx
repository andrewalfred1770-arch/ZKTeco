import React from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Surface in DevTools for debugging without polluting production console
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary]', error, info.componentStack);
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        dir="rtl"
        style={{
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          flex: 1, gap: 16, padding: 40, textAlign: 'center',
        }}
      >
        <AlertTriangle style={{ width: 48, height: 48, color: '#DC2626', opacity: 0.8 }} />
        <div>
          <p style={{ fontWeight: 700, fontSize: 16, color: 'var(--erp-text)', fontFamily: 'Cairo,sans-serif' }}>
            حدث خطأ غير متوقع في هذه الصفحة
          </p>
          <p style={{ fontSize: 13, color: 'var(--erp-text-muted)', marginTop: 6, fontFamily: 'Cairo,sans-serif' }}>
            {this.state.error?.message || 'يرجى إعادة تحميل الصفحة أو التواصل مع الدعم الفني.'}
          </p>
        </div>
        <button
          onClick={() => this.setState({ hasError: false, error: null })}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 20px', borderRadius: 8, cursor: 'pointer',
            background: 'var(--accent, #2563EB)', color: '#fff',
            border: 'none', fontFamily: 'Cairo,sans-serif', fontWeight: 700, fontSize: 14,
          }}
        >
          <RefreshCw style={{ width: 16, height: 16 }} />
          إعادة المحاولة
        </button>
      </div>
    );
  }
}
