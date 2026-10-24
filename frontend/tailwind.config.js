/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Cairo', 'Segoe UI', 'Tahoma', 'Arial', 'sans-serif'],
        mono: ['Consolas', 'Courier New', 'monospace'],
      },
      colors: {
        // NOTE: Tailwind's default `gray` scale is intentionally NOT overridden here (the light theme depends on the stock values).
        // The dark theme re-colours the gray-* utilities only under `html:not(.light)` in src/styles/checkin-tokens.css.
        // CheckIn brand green, sampled from the approved logo. 500 = logo green (#4FBF6B); 600 is the accessible fill for white text (5.1:1).
        primary: {
          50:  '#E9F4EC',
          100: '#D3EADA',
          200: '#A9D5B5',
          300: '#7FC08F',
          400: '#5FC57A',
          500: '#4FBF6B',
          600: '#1E7A34',
          700: '#17632A',
          800: '#124F22',
          900: '#0D3B19',
        },
        brand: {
          charcoal: '#293438',
          deep:     '#20282B',
          green:    '#4FBF6B',
          'green-dark': '#3FA85C',
          tint:     '#E9F4EC',
        },
        accent: 'var(--accent)',
      },
      spacing: {
        '18': '4.5rem',
      },
    },
  },
  plugins: [],
};
