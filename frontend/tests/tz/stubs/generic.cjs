// Generic stand-in for third-party UI libraries (lucide-react, ag-grid, recharts, react-hot-toast, ...) in the isolated renderer
// tests. Every import is a component that renders nothing; calls return null. Router hooks return harmless values.
const stub = new Proxy(function Stub() { return null; }, {
  get: (_t, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : stub),
  apply: () => null,
  construct: () => ({}),
});
const hooks = {
  useNavigate: () => () => {},
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), () => {}],
};
module.exports = new Proxy({}, {
  get: (_t, k) => {
    if (k === '__esModule') return false;
    if (k in hooks) return hooks[k];
    return stub;
  },
});
