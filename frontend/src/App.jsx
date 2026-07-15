import React, { useEffect, useState, Suspense, lazy } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import NetworkBanner from './components/NetworkBanner';
import ConnectionStatusBanner from './components/ConnectionStatusBanner';
import UpdateNotifications from './components/UpdateNotifications';
import DatabaseSetupWizard from './components/DatabaseSetupWizard';
import ConnectionWizard from './components/ConnectionWizard';
import LoginScreen from './components/LoginScreen';
import { isManager } from './lib/edition';
import useAuthStore from './store/authStore';
// EP-015: route-level code splitting — each page is its own chunk, fetched
// only when navigated to, instead of one bundle containing every page
// (AG Grid, recharts, print/xlsx code, etc.) up front at startup.
const DashboardPage         = lazy(() => import('./pages/DashboardPage'));
const AttendanceDailyPage   = lazy(() => import('./pages/AttendanceDailyPage'));
const AttendanceMonthlyPage = lazy(() => import('./pages/AttendanceMonthlyPage'));
const EmployeeMovementPage  = lazy(() => import('./pages/EmployeeMovementPage'));
const EmployeesPage         = lazy(() => import('./pages/EmployeesPage'));
const DevicesPage           = lazy(() => import('./pages/DevicesPage'));
const PayrollPage           = lazy(() => import('./pages/PayrollPage'));
const RulesPage              = lazy(() => import('./pages/RulesPage'));
const HolidaysPage           = lazy(() => import('./pages/HolidaysPage'));
const RawLogsPage            = lazy(() => import('./pages/RawLogsPage'));
const SettingsPage           = lazy(() => import('./pages/SettingsPage'));
const CompanySettingsPage    = lazy(() => import('./pages/CompanySettingsPage'));
const DataCleanupPage        = lazy(() => import('./pages/DataCleanupPage'));
const AttendanceSettingsPage = lazy(() => import('./pages/AttendanceSettingsPage'));
const ConnectionSettingsPage = lazy(() => import('./pages/ConnectionSettingsPage'));
import useCompanySettingsStore from './store/companySettingsStore';
import { getSocket } from './lib/socket';
import { BRAND } from './lib/branding';

// ─── Manager Edition gate (EP-011) ────────────────────────────────────────────
// No-op on Server builds (renders children immediately, unchanged behavior).
// On Manager builds, blocks the app behind two existing-infrastructure checks
// before any page/socket/company-settings fetch happens:
//   1. Is a server address saved? (connection-settings.json, EP-003) — if not,
//      show the first-run Connection Wizard.
//   2. Does that server require login? (GET /api/auth/me, already implemented
//      in backend/src/routes/auth.js) — if so and no valid session is loaded,
//      show the Login screen.
function ManagerGate({ children }) {
  const [connSettings, setConnSettings] = useState(undefined); // undefined = still loading
  const hydrate     = useAuthStore((s) => s.hydrate);
  const hydrated    = useAuthStore((s) => s.hydrated);
  const authEnabled = useAuthStore((s) => s.authEnabled);
  const token       = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!isManager) return;
    window.electron.connection.getSettings()
      .then(setConnSettings)
      .catch(() => setConnSettings({ mode: 'server', serverUrl: '' }));
  }, []);

  useEffect(() => {
    if (!isManager || !connSettings?.serverUrl) return;
    hydrate();
  }, [connSettings, hydrate]);

  if (!isManager) return children;
  if (connSettings === undefined) return null; // splash screen already covers this brief window
  if (!connSettings.serverUrl) return <ConnectionWizard />;
  if (!hydrated) return null;
  // Server was unreachable when we probed /api/auth/me (authStore leaves
  // authEnabled === null rather than guessing true/false in that case — see
  // authStore.js:checkAuthRequired). Falling through to `children` here would
  // silently render the full app against a dead backend with no feedback.
  // Reuse the existing Connection Wizard (test/retry a server address) rather
  // than invent a new screen.
  if (authEnabled === null) return <ConnectionWizard />;
  if (authEnabled === true && !token) return <LoginScreen />;

  return (
    <>
      {authEnabled === false && (
        <div style={{
          padding: '6px 16px', background: 'rgba(245,158,11,0.12)', borderBottom: '1px solid rgba(245,158,11,0.3)',
          fontSize: 12, color: '#92400e', textAlign: 'center', flexShrink: 0,
        }}>
          ⚠ الخادم المتصل لا يتطلب تسجيل دخول (AUTH_ENABLED=false) — يُنصح بتفعيل المصادقة عند استخدام أكثر من جهاز
        </div>
      )}
      {children}
    </>
  );
}

// Inner component so Toaster can read theme from context
function AppRoutes() {
  const { resolved } = useTheme();

  // Temporary build marker — proves which bundle/EXE build is actually
  // running (renderer side). Prefers the Electron main-process IPC value
  // (guaranteed to match the packaged app.asar); falls back to the static
  // BRAND constant in the browser/dev preview. See electron.js BUILD_MARKER.
  useEffect(() => {
    if (window?.electron?.buildMarker) {
      window.electron.buildMarker()
        .then((marker) => console.log(`%c[PETSHROW ERP] ${marker}`, 'color:#2563eb;font-weight:bold;'))
        .catch(() => console.log(`%c[PETSHROW ERP] ${BRAND.buildMarker}`, 'color:#2563eb;font-weight:bold;'));
    } else {
      console.log(`%c[PETSHROW ERP] ${BRAND.buildMarker}`, 'color:#2563eb;font-weight:bold;');
    }
  }, []);

  return (
    <>
      <Toaster
        position="top-left"
        toastOptions={{
          style: {
            background: resolved === 'light' ? '#ffffff' : '#1f2937',
            color:      resolved === 'light' ? '#0f172a' : '#f3f4f6',
            border:     resolved === 'light' ? '1px solid #e2e8f0' : '1px solid #374151',
            fontFamily: 'Cairo, sans-serif',
            fontSize:   '13px',
            direction:  'rtl',
            boxShadow:  '0 4px 12px rgba(0,0,0,0.15)',
          },
          duration: 3000,
        }}
      />
      {/* EP-011: Manager builds have no server MySQL credentials to fix — a
          Manager user seeing "DB auth failed, enter credentials" would be
          asked to configure a machine that isn't theirs. Server builds are
          unaffected (isManager is always false there). */}
      {!isManager && <DatabaseSetupWizard />}
      {/* EP-011: gates the routed app behind connection + auth state on
          Manager builds; a pure pass-through on Server builds. The
          company-settings fetch + live-sync socket subscription below only
          fire once this resolves, so Manager never calls the API before a
          server is configured and (if required) a session exists. */}
      <ManagerGate>
        <AppShellRoutes />
      </ManagerGate>
    </>
  );
}

// Split out of AppRoutes so its company-settings fetch + socket subscription
// only run once ManagerGate has let the app through (see AppRoutes above).
function AppShellRoutes() {
  const fetchCompanySettings = useCompanySettingsStore((s) => s.fetch);

  // Load "بيانات الشركة" once at startup, then keep it live: any edit anywhere
  // (this window or another) broadcasts 'company-settings:changed' over the
  // shared socket, and every screen reading useCompanyBrand()/the store
  // re-renders instantly — no manual refresh needed.
  useEffect(() => {
    fetchCompanySettings();
    const socket = getSocket();
    const onChanged = () => fetchCompanySettings();
    socket.on('company-settings:changed', onChanged);
    return () => socket.off('company-settings:changed', onChanged);
  }, [fetchCompanySettings]);

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"             element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
          <Route path="attendance/daily"      element={<ErrorBoundary><AttendanceDailyPage /></ErrorBoundary>} />
          <Route path="attendance/monthly"    element={<ErrorBoundary><AttendanceMonthlyPage /></ErrorBoundary>} />
          <Route path="attendance/movement"   element={<ErrorBoundary><EmployeeMovementPage /></ErrorBoundary>} />
          <Route path="attendance/logs"       element={<ErrorBoundary><RawLogsPage /></ErrorBoundary>} />
          <Route path="employees"             element={<ErrorBoundary><EmployeesPage /></ErrorBoundary>} />
          {/* EP-011: device configuration + the local/server connection toggle
              are server-admin functionality — routes excluded outright on
              Manager builds (not just hidden from the sidebar), so they're
              unreachable even by direct URL/hash navigation. */}
          {!isManager && <Route path="devices"             element={<ErrorBoundary><DevicesPage /></ErrorBoundary>} />}
          <Route path="payroll"               element={<ErrorBoundary><PayrollPage /></ErrorBoundary>} />
          <Route path="attendance/settings"   element={<ErrorBoundary><AttendanceSettingsPage /></ErrorBoundary>} />
          <Route path="rules"                 element={<ErrorBoundary><RulesPage /></ErrorBoundary>} />
          <Route path="holidays"              element={<ErrorBoundary><HolidaysPage /></ErrorBoundary>} />
          <Route path="settings"              element={<ErrorBoundary><SettingsPage /></ErrorBoundary>} />
          <Route path="settings/company"      element={<ErrorBoundary><CompanySettingsPage /></ErrorBoundary>} />
          {!isManager && <Route path="settings/connection" element={<ErrorBoundary><ConnectionSettingsPage /></ErrorBoundary>} />}
          <Route path="maintenance/cleanup"   element={<ErrorBoundary><DataCleanupPage /></ErrorBoundary>} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <HashRouter>
        <NetworkBanner />
        <ConnectionStatusBanner />
        <UpdateNotifications />
        <AppRoutes />
      </HashRouter>
    </ThemeProvider>
  );
}
