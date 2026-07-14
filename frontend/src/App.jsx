import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import NetworkBanner from './components/NetworkBanner';
import UpdateNotifications from './components/UpdateNotifications';
import DashboardPage         from './pages/DashboardPage';
import AttendanceDailyPage   from './pages/AttendanceDailyPage';
import AttendanceMonthlyPage from './pages/AttendanceMonthlyPage';
import EmployeeMovementPage  from './pages/EmployeeMovementPage';
import EmployeesPage         from './pages/EmployeesPage';
import DevicesPage           from './pages/DevicesPage';
import PayrollPage           from './pages/PayrollPage';
import RulesPage             from './pages/RulesPage';
import HolidaysPage          from './pages/HolidaysPage';
import RawLogsPage           from './pages/RawLogsPage';
import SettingsPage          from './pages/SettingsPage';
import CompanySettingsPage   from './pages/CompanySettingsPage';
import DataCleanupPage          from './pages/DataCleanupPage';
import AttendanceSettingsPage   from './pages/AttendanceSettingsPage';
import ConnectionSettingsPage   from './pages/ConnectionSettingsPage';
import useCompanySettingsStore from './store/companySettingsStore';
import { getSocket } from './lib/socket';
import { BRAND } from './lib/branding';

// Inner component so Toaster can read theme from context
function AppRoutes() {
  const { resolved } = useTheme();
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
      <NetworkBanner />
      <UpdateNotifications />
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
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"             element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
          <Route path="attendance/daily"      element={<ErrorBoundary><AttendanceDailyPage /></ErrorBoundary>} />
          <Route path="attendance/monthly"    element={<ErrorBoundary><AttendanceMonthlyPage /></ErrorBoundary>} />
          <Route path="attendance/movement"   element={<ErrorBoundary><EmployeeMovementPage /></ErrorBoundary>} />
          <Route path="attendance/logs"       element={<ErrorBoundary><RawLogsPage /></ErrorBoundary>} />
          <Route path="employees"             element={<ErrorBoundary><EmployeesPage /></ErrorBoundary>} />
          <Route path="devices"               element={<ErrorBoundary><DevicesPage /></ErrorBoundary>} />
          <Route path="payroll"               element={<ErrorBoundary><PayrollPage /></ErrorBoundary>} />
          <Route path="attendance/settings"   element={<ErrorBoundary><AttendanceSettingsPage /></ErrorBoundary>} />
          <Route path="rules"                 element={<ErrorBoundary><RulesPage /></ErrorBoundary>} />
          <Route path="holidays"              element={<ErrorBoundary><HolidaysPage /></ErrorBoundary>} />
          <Route path="settings"              element={<ErrorBoundary><SettingsPage /></ErrorBoundary>} />
          <Route path="settings/company"      element={<ErrorBoundary><CompanySettingsPage /></ErrorBoundary>} />
          <Route path="settings/connection"   element={<ErrorBoundary><ConnectionSettingsPage /></ErrorBoundary>} />
          <Route path="maintenance/cleanup"   element={<ErrorBoundary><DataCleanupPage /></ErrorBoundary>} />
        </Route>
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </ThemeProvider>
  );
}
