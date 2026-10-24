import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './styles/checkin-tokens.css';   // CheckIn brand tokens: loaded after index.css so they re-point its theme variables

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('[React crash]', e, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          height:'100vh', background:'#090909', color:'#F5F5F5', fontFamily:'monospace',
          padding:'32px', gap:'16px', direction:'ltr',
        }}>
          <div style={{fontSize:'18px', color:'#f87171', fontWeight:'bold'}}>
            Renderer Error — React crashed on startup
          </div>
          <pre style={{
            background:'#151515', padding:'16px', borderRadius:'8px',
            fontSize:'12px', color:'#fca5a5', maxWidth:'800px', overflow:'auto',
            whiteSpace:'pre-wrap', border:'1px solid #2D2D2D',
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
