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
import useCompanySettingsStore from './store/companySettingsStore';

import { getSocket } from './lib/socket';
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
function ManagerGate({ children }) {
  trace("ManagerGate render");

  const [connSettings, setConnSettings] = useState(undefined);

  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrated = useAuthStore((s) => s.hydrated);
  const authEnabled = useAuthStore((s) => s.authEnabled);
  const token = useAuthStore((s) => s.token);

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
    return null;
  }

  if (authEnabled === null) {
    trace("Server unreachable");
    return <ConnectionWizard />;
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

    return () => {
      trace("Socket cleanup");

      socket.off("company-settings:changed", onChanged);
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

          {!isManager && (
            <Route
              path="settings/connection"
              element={
                <ErrorBoundary>
                  <ConnectionSettingsPage />
                </ErrorBoundary>
              }
            />
          )}

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