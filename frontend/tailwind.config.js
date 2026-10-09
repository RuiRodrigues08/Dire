// As cores, cantos, letra e largura vêm de variáveis CSS (ver src/styles/theme.css),
// por isso mudar uma definição altera a app em direto, sem recarregar.
const c = (name) => `rgb(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: c('bg'),
        surface: c('surface'),
        'surface-2': c('surface-2'),
        fg: c('text'),
        muted: c('muted'),
        line: c('border'),
        accent: c('accent'),
        'accent-fg': c('accent-text'),
        danger: c('danger'),
        warn: c('warn'),
        ok: c('ok'),
      },
      borderRadius: {
        ui: 'var(--radius)',
        'ui-sm': 'calc(var(--radius) * 0.6)',
        'ui-lg': 'calc(var(--radius) * 1.5)',
      },
      fontFamily: { ui: 'var(--font)', mono: 'var(--font-mono)', serif: ["'Source Serif 4'", 'Georgia', 'serif'] },
      maxWidth: { chat: 'var(--chat-width)' },
    },
  },
  plugins: [],
}
