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
import ServerReadyGate from './components/ServerReadyGate';

import { isManager } from './lib/edition';
import useAuthStore from './store/authStore';
import useCompanySettingsStore, { shouldRefetchOnStatus } from './store/companySettingsStore';

import { getSocket, subscribeConnectionStatus } from './lib/socket';
import { BRAND } from './lib/branding';

/* ============================================================================
 * Boot Tracing System
 * ========================================================================== */

const TRACE_BOOT = true;

function trace(step, data = null) {
  if (!TRACE_BOOT) return;

  const style =
    'background:#2563eb;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold';

  if (data === null || data === undefined) {
    console.log('%c[BOOT]', style, step);
  } else {
    console.log('%c[BOOT]', style, step, data);
  }
}

/* ============================================================================
 * Lazy Loaded Pages
 * ========================================================================== */

const DashboardPage = lazy(() => import('./pages/DashboardPage'));

const AttendanceDailyPage = lazy(() =>
  import('./pages/AttendanceDailyPage')
);

const AttendanceMonthlyPage = lazy(() =>
  import('./pages/AttendanceMonthlyPage')
);

const EmployeeMovementPage = lazy(() =>
  import('./pages/EmployeeMovementPage')
);

const EmployeesPage = lazy(() =>
  import('./pages/EmployeesPage')
);

const DevicesPage = lazy(() =>
  import('./pages/DevicesPage')
);

const PayrollPage = lazy(() =>
  import('./pages/PayrollPage')
);

const RulesPage = lazy(() =>
  import('./pages/RulesPage')
);

const HolidaysPage = lazy(() =>
  import('./pages/HolidaysPage')
);

const RawLogsPage = lazy(() =>
  import('./pages/RawLogsPage')
);

const SettingsPage = lazy(() =>
  import('./pages/SettingsPage')
);

const CompanySettingsPage = lazy(() =>
  import('./pages/CompanySettingsPage')
);

const DataCleanupPage = lazy(() =>
  import('./pages/DataCleanupPage')
);

const AttendanceSettingsPage = lazy(() =>
  import('./pages/AttendanceSettingsPage')
);

const ConnectionSettingsPage = lazy(() =>
  import('./pages/ConnectionSettingsPage')
);

/* ============================================================================
 * Manager Gate
 * ========================================================================== */

// Shown (instead of a blank screen or the first-run setup wizard) while a
// Manager client that ALREADY has a saved server address waits for that server
// — at launch, after a server restart, or after a Wi-Fi drop. The saved
// address is never cleared or re-asked; retries happen automatically.
function ConnectingScreen({ serverUrl, onRetry, onChangeServer }) {
  return (
    <div
      dir="rtl"
      style={{
        position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 14,
        background: 'var(--bg, #0b1220)', color: 'var(--text, #e2e8f0)', zIndex: 9999,
      }}
    >
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        border: '3px solid rgba(148,163,184,0.25)', borderTopColor: '#3b82f6',
        animation: 'spin 0.8s linear infinite',
      }} />
      <div style={{ fontSize: 14, fontWeight: 700 }}>جاري الاتصال بالخادم…</div>
      {serverUrl && (
        <div style={{ fontSize: 12, color: 'var(--text-3, #94a3b8)', direction: 'ltr' }}>{serverUrl}</div>
      )}
      {onRetry && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-3, #94a3b8)', textAlign: 'center', maxWidth: 340 }}>
            الخادم غير متاح حاليًا. سيعيد البرنامج المحاولة تلقائيًا ويتصل فور عودته — لا حاجة لأي إجراء.
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={onRetry}
              style={{ padding: '7px 18px', borderRadius: 8, border: '1px solid #2563eb', background: '#1d4ed8', color: '#fff', fontSize: 12.5, cursor: 'pointer' }}
            >
              إعادة المحاولة الآن
            </button>
            <button
              onClick={onChangeServer}
              style={{ padding: '7px 18px', borderRadius: 8, border: '1px solid rgba(148,163,184,0.4)', background: 'transparent', color: 'inherit', fontSize: 12.5, cursor: 'pointer' }}
            >
              تغيير عنوان الخادم
            </button>
          </div>
        </>
      )}
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

function ManagerGate({ children }) {
  trace("ManagerGate render");

  const [connSettings, setConnSettings] = useState(undefined);

  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrated = useAuthStore((s) => s.hydrated);
  const authEnabled = useAuthStore((s) => s.authEnabled);
  const token = useAuthStore((s) => s.token);
  const checkAuthRequired = useAuthStore((s) => s.checkAuthRequired);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    trace("ManagerGate effect", { isManager });

    if (!isManager) return;

    window.electron.connection
      .getSettings()
      .then((settings) => {
        trace("Connection Settings Loaded", settings);
        setConnSettings(settings);
      })
      .catch((err) => {
        console.error("[BOOT] Failed to load connection settings", err);

        setConnSettings({
          mode: "server",
          serverUrl: "",
        });
      });
  }, []);

  useEffect(() => {
    if (!isManager) return;
    if (!connSettings?.serverUrl) return;

    trace("Hydrating authentication");

    hydrate();
  }, [connSettings, hydrate]);

  // Server unreachable (authEnabled still unknown) with a saved address: keep
  // probing in the background with a growing delay (2s → 15s cap) until it
  // answers. Never touches the saved settings.
  useEffect(() => {
    if (!isManager || !hydrated || !connSettings?.serverUrl || authEnabled !== null) return;
    let cancelled = false;
    const delay = Math.min(2000 * Math.pow(1.5, probeAttempt), 15000);
    const timer = setTimeout(async () => {
      await checkAuthRequired();
      if (!cancelled) setProbeAttempt((n) => n + 1);
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hydrated, connSettings, authEnabled, probeAttempt, checkAuthRequired]);

  if (!isManager) {
    trace("Server Edition");
    return children;
  }

  if (connSettings === undefined) {
    trace("Waiting for connection settings...");
    return null;
  }

  if (!connSettings.serverUrl) {
    trace("No server configured");
    return <ConnectionWizard />;
  }

  if (!hydrated) {
    trace("Waiting for auth hydration...");
    return <ConnectingScreen serverUrl={connSettings.serverUrl} />;
  }

  if (authEnabled === null) {
    trace("Server unreachable — auto-retrying, saved address kept");
    if (showWizard) return <ConnectionWizard initialUrl={connSettings.serverUrl} />;
    return (
      <ConnectingScreen
        serverUrl={connSettings.serverUrl}
        onRetry={() => { setProbeAttempt(0); checkAuthRequired(); }}
        onChangeServer={() => setShowWizard(true)}
      />
    );
  }

  if (authEnabled === true && !token) {
    trace("Authentication required");
    return <LoginScreen />;
  }

  trace("ManagerGate passed");

  return (
    <>
      {authEnabled === false && (
        <div
          style={{
            padding: "6px 16px",
            background: "rgba(245,158,11,0.12)",
            borderBottom: "1px solid rgba(245,158,11,0.30)",
            fontSize: 12,
            color: "#92400e",
            textAlign: "center",
            flexShrink: 0,
          }}
        >
          ⚠ الخادم الحالي لا يتطلب تسجيل دخول
          (AUTH_ENABLED=false) — يُنصح بتفعيل المصادقة.
        </div>
      )}

      {children}
    </>
  );
}
/* ============================================================================
 * App Routes
 * ========================================================================== */

function AppRoutes() {
  trace("AppRoutes render");

  const { resolved } = useTheme();

  useEffect(() => {
    trace("Renderer Build Marker");

    if (window?.electron?.buildMarker) {
      window.electron
        .buildMarker()
        .then((marker) => {
          console.log(
            `%c[PETSHROW ERP] ${marker}`,
            "color:#2563eb;font-weight:bold;"
          );
        })
        .catch(() => {
          console.log(
            `%c[PETSHROW ERP] ${BRAND.buildMarker}`,
            "color:#2563eb;font-weight:bold;"
          );
        });
    } else {
      console.log(
        `%c[PETSHROW ERP] ${BRAND.buildMarker}`,
        "color:#2563eb;font-weight:bold;"
      );
    }
  }, []);

  return (
    <>
      <Toaster
        position="top-left"
        toastOptions={{
          duration: 3000,
          className: "toast-pop",
          style: {
            // Light branch keeps its exact original literal values
            // (unchanged theme, per design-system scope). Dark branch now
            // reads from the shared token system instead of one-off hex.
            background: resolved === "light" ? "#ffffff" : "var(--surface-3)",
            color: resolved === "light" ? "#0f172a" : "var(--text)",
            border:
              resolved === "light"
                ? "1px solid #e2e8f0"
                : "1px solid var(--border)",
            fontFamily: "Cairo, sans-serif",
            fontSize: "13px",
            direction: "rtl",
            boxShadow:
              resolved === "light" ? "0 4px 12px rgba(0,0,0,.15)" : "var(--shadow-md)",
            zIndex: "var(--z-toast)",
          },
        }}
      />

      {!isManager && <DatabaseSetupWizard />}

      <ManagerGate>
        <ServerReadyGate>
          <AppShellRoutes />
        </ServerReadyGate>
      </ManagerGate>
    </>
  );
}

/* ============================================================================
 * Application Shell
 * ========================================================================== */

function AppShellRoutes() {
  trace("AppShellRoutes render");

  const fetchCompanySettings = useCompanySettingsStore(
    (s) => s.fetch
  );

  useEffect(() => {
    trace("Loading company settings...");

    fetchCompanySettings();

    const socket = getSocket();

    trace("Socket initialized");

    const onChanged = () => {
      trace("Company settings changed");

      fetchCompanySettings();
    };

    socket.on("company-settings:changed", onChanged);

    // F-15: the fetch above can fail (server still starting / connection dropped)
    // and nothing used to retry it, so the "company data" banner stayed on screen
    // until a manual reload. The realtime link already tells us when the server
    // is reachable again — refresh once on every transition INTO 'connected'
    // (the first, immediate callback is the initial state and is skipped, the
    // mount fetch covers it). No polling.
    let prevStatus = null;
    const unsubscribeStatus = subscribeConnectionStatus((status) => {
      if (shouldRefetchOnStatus(prevStatus, status, useCompanySettingsStore.getState())) {
        trace("Socket (re)connected - refreshing company settings");
        fetchCompanySettings();
      }
      prevStatus = status;
    });

    return () => {
      trace("Socket cleanup");

      socket.off("company-settings:changed", onChanged);
      unsubscribeStatus();
    };
  }, [fetchCompanySettings]);

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Layout />}>

          <Route
            index
            element={<Navigate to="/dashboard" replace />}
          />

          <Route
            path="dashboard"
            element={
              <ErrorBoundary>
                <DashboardPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="attendance/daily"
            element={
              <ErrorBoundary>
                <AttendanceDailyPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="attendance/monthly"
            element={
              <ErrorBoundary>
                <AttendanceMonthlyPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="attendance/movement"
            element={
              <ErrorBoundary>
                <EmployeeMovementPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="attendance/logs"
            element={
              <ErrorBoundary>
                <RawLogsPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="employees"
            element={
              <ErrorBoundary>
                <EmployeesPage />
              </ErrorBoundary>
            }
          />

          {!isManager && (
            <Route
              path="devices"
              element={
                <ErrorBoundary>
                  <DevicesPage />
                </ErrorBoundary>
              }
            />
          )}

          <Route
            path="payroll"
            element={
              <ErrorBoundary>
                <PayrollPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="attendance/settings"
            element={
              <ErrorBoundary>
                <AttendanceSettingsPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="rules"
            element={
              <ErrorBoundary>
                <RulesPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="holidays"
            element={
              <ErrorBoundary>
                <HolidaysPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="settings"
            element={
              <ErrorBoundary>
                <SettingsPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="settings/company"
            element={
              <ErrorBoundary>
                <CompanySettingsPage />
              </ErrorBoundary>
            }
          />

          <Route
            path="settings/connection"
            element={
              <ErrorBoundary>
                <ConnectionSettingsPage />
              </ErrorBoundary>
            }
          />

          <Route
  path="maintenance/cleanup"
  element={
    <ErrorBoundary>
      <DataCleanupPage />
    </ErrorBoundary>
  }
/>

</Route>

</Routes>
</Suspense>
);
}
/* ============================================================================
 * Root Application
 * ========================================================================== */

export default function App() {
  trace("Application render started");

  useEffect(() => {
    trace("React mounted successfully");

    return () => {
      trace("React unmounted");
    };
  }, []);

  return (
    <ThemeProvider>
      <AppBootstrap />
    </ThemeProvider>
  );
}

/* ============================================================================
 * Bootstrap
 * ========================================================================== */

function AppBootstrap() {
  trace("ThemeProvider ready");

  useEffect(() => {
    trace("HashRouter initializing...");
  }, []);

  return (
    <HashRouter>
      <NetworkBanner />
      <ConnectionStatusBanner />
      <UpdateNotifications />

      <AppRoutes />
    </HashRouter>
  );
}