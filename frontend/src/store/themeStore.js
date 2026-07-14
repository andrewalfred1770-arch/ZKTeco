// Desktop app is always dark mode — no toggle needed
// Returns a compatible object for any remaining references
const useThemeStore = () => ({ theme: 'dark', toggleTheme: () => {}, initTheme: () => {} });
export default useThemeStore;
