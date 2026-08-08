import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('[React crash]', e, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          height:'100vh', background:'#0D1117', color:'#f1f5f9', fontFamily:'monospace',
          padding:'32px', gap:'16px', direction:'ltr',
        }}>
          <div style={{fontSize:'18px', color:'#f87171', fontWeight:'bold'}}>
            Renderer Error — React crashed on startup
          </div>
          <pre style={{
            background:'#21262D', padding:'16px', borderRadius:'8px',
            fontSize:'12px', color:'#fca5a5', maxWidth:'800px', overflow:'auto',
            whiteSpace:'pre-wrap', border:'1px solid #30363D',
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
