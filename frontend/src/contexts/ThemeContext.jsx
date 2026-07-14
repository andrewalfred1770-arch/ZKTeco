/**
 * Global Theme Context
 * Supports: 'light' | 'dark' | 'system'
 *
 * Applies a class on <html> ('light' or 'dark') which drives all CSS variables.
 * Persists choice to localStorage.
 * Exposes agGridTheme so all AG Grid tables switch in sync.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext({
  theme:       'dark',
  resolved:    'dark',
  setTheme:    () => {},
  agGridTheme: 'ag-theme-quartz-dark',
  isLight:     false,
});

const STORAGE_KEY = 'erp-theme';

function getSystemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.setAttribute('data-theme', resolved);
}

export function ThemeProvider({ children }) {
  // 'light' | 'dark' | 'system'
  const [theme, setThemeRaw] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ?? 'dark';
  });

  // The actual resolved theme ('light' | 'dark')
  const [systemTheme, setSystemTheme] = useState(() => getSystemTheme());

  // Listen for system changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolved = useMemo(() =>
    theme === 'system' ? systemTheme : theme,
    [theme, systemTheme]
  );

  // Apply the class whenever resolved changes
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setTheme = useCallback((t) => {
    setThemeRaw(t);
    localStorage.setItem(STORAGE_KEY, t);
  }, []);

  const value = useMemo(() => ({
    theme,          // user preference ('light' | 'dark' | 'system')
    resolved,       // actual applied theme
    setTheme,
    isLight:    resolved === 'light',
    isDark:     resolved === 'dark',
    agGridTheme: resolved === 'light' ? 'ag-theme-quartz' : 'ag-theme-quartz-dark',
  }), [theme, resolved, setTheme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
