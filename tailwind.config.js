/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/web/**/*.html', './src/web/**/*.js'],
  theme: { extend: {} },
  plugins: [require('daisyui')],
  daisyui: {
    themes: ['night'],
    logs: false,
  },
};
