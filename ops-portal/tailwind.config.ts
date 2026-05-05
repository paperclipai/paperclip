import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: {
          950: '#07071a',
          900: '#0d0d2b',
          800: '#13133d',
        },
        nova: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
        star: {
          400: '#fbbf24',
          500: '#f59e0b',
        },
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'ui-monospace', 'Menlo', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};

export default config;
