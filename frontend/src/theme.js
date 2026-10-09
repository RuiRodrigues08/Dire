// Definições de aparência: as mesmas chaves e valores que o servidor aceita
// (backend/app/core/user_settings.py). Aplicar = mudar variáveis CSS na raiz.

export const DEFAULTS = {
  theme: 'system',
  accent: '#1E4A62', // azul do logo
  font: 'sans',
  font_size: 'm',
  density: 'normal',
  radius: 'lg',
  chat_width: 'medium',
  message_style: 'modern',
  background: 'plain',
  login_background: 'default',
  send_with: 'enter',
  sources_open: false,
  show_tokens: false,
  confirm_delete: true,
}

export const APPEARANCE_KEYS = [
  'theme', 'accent', 'font', 'font_size', 'density', 'radius', 'chat_width', 'message_style', 'background',
  'login_background',
]
export const CHAT_KEYS = ['send_with', 'sources_open', 'show_tokens', 'confirm_delete']

export const ACCENTS = [
  '#1E4A62', '#7C5CFF', '#2563EB', '#0891B2', '#059669', '#65A30D', '#D97706', '#E11D48', '#DB2777',
]

// Cores em "R G B" para poderem levar transparência no Tailwind (rgb(var(--x) / 0.5)).
const THEMES = {
  // Página cinzenta-fria e painéis brancos, para as zonas se distinguirem (barra lateral, cartões, menus).
  light: {
    scheme: 'light',
    bg: '238 240 243', surface: '255 255 255', 'surface-2': '231 234 238',
    text: '20 22 28', muted: '92 96 108', border: '214 218 225',
    danger: '220 38 38', warn: '180 120 0', ok: '22 140 70',
  },
  dark: {
    scheme: 'dark',
    bg: '17 17 19', surface: '24 24 27', 'surface-2': '34 34 38',
    text: '240 240 242', muted: '150 150 158', border: '44 44 49',
    danger: '248 113 113', warn: '250 204 21', ok: '74 222 128',
  },
  sepia: {
    scheme: 'light',
    bg: '244 236 222', surface: '251 246 236', 'surface-2': '236 226 208',
    text: '59 47 34', muted: '128 110 88', border: '221 207 184',
    danger: '185 28 28', warn: '161 98 7', ok: '21 128 61',
  },
  high_contrast: {
    scheme: 'dark',
    bg: '0 0 0', surface: '0 0 0', 'surface-2': '24 24 24',
    text: '255 255 255', muted: '210 210 210', border: '255 255 255',
    danger: '255 90 90', warn: '255 220 0', ok: '0 255 120',
  },
}

const FONTS = {
  sans: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "'Source Serif 4', Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
}
const FONT_SIZES = { s: '14px', m: '16px', l: '18px', xl: '20px' }
const DENSITY = { compact: '0.7', normal: '1', comfortable: '1.35' }
const RADIUS = { none: '0rem', sm: '0.25rem', md: '0.5rem', lg: '0.75rem', xl: '1.25rem' }
const CHAT_WIDTH = { narrow: '40rem', medium: '48rem', wide: '64rem' }

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrastRatio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

/**
 * Texto sobre a cor de destaque: branco sempre que tiver pelo menos 3:1 (AA para texto grande e
 * componentes; nas cores saturadas lê-se melhor que o preto), senão o que contrastar mais.
 * O mesmo cálculo do servidor (user_settings.contrast_text).
 */
function accentText(hex) {
  const rgb = hexToRgb(hex)
  const white = contrastRatio(rgb, [255, 255, 255])
  return white >= 3 || white >= contrastRatio(rgb, [0, 0, 0]) ? '255 255 255' : '0 0 0'
}

export function resolveTheme(theme) {
  if (theme !== 'system') return theme
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Contraste entre o destaque escolhido e o fundo do tema (para avisar quando é ajustado). */
export function accentContrast(settings) {
  const t = THEMES[resolveTheme(settings.theme)]
  return contrastRatio(hexToRgb(settings.accent), t.bg.split(' ').map(Number))
}

/**
 * Destaque usado no ecrã: se tiver pouco contraste com o fundo (ex.: o azul escuro do logo no tema
 * escuro), aproxima-se do branco (temas escuros, até 4.5:1, porque serve de cor de texto) ou do
 * preto (claros, até 3:1).
 */
function visibleAccent(rgb, t) {
  const bg = t.bg.split(' ').map(Number)
  const dark = t.scheme === 'dark'
  const target = dark ? 255 : 0
  const min = dark ? 4.5 : 3
  let out = rgb
  for (let k = 0.05; contrastRatio(out, bg) < min && k <= 1; k += 0.05) {
    out = rgb.map((c) => Math.round(c + (target - c) * k))
  }
  return out
}

export function applySettings(input) {
  const s = { ...DEFAULTS, ...input }
  const root = document.documentElement
  const t = THEMES[resolveTheme(s.theme)] || THEMES.light
  for (const [k, v] of Object.entries(t)) {
    if (k !== 'scheme') root.style.setProperty(`--${k}`, v)
  }
  root.style.colorScheme = t.scheme
  const accent = visibleAccent(hexToRgb(s.accent), t)
  root.style.setProperty('--accent', accent.join(' '))
  root.style.setProperty('--accent-text', accentText('#' + accent.map((c) => c.toString(16).padStart(2, '0')).join('')))
  root.style.setProperty('--font', FONTS[s.font] || FONTS.sans)
  root.style.setProperty('--font-size', FONT_SIZES[s.font_size] || FONT_SIZES.m)
  root.style.setProperty('--density', DENSITY[s.density] || '1')
  root.style.setProperty('--radius', RADIUS[s.radius] ?? RADIUS.lg)
  root.style.setProperty('--chat-width', CHAT_WIDTH[s.chat_width] || CHAT_WIDTH.medium)
  root.dataset.theme = resolveTheme(s.theme)
}

// Cópia local para aplicar o tema antes de a app desenhar (evita piscar ao abrir).
const CACHE_KEY = 'rag.settings'

export function cacheSettings(s) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s))
  } catch {
    /* modo privado: sem cache */
  }
}

export function cachedSettings() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearCachedSettings() {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* ignorar */
  }
}

/** Só as chaves que o servidor aceita (o GET devolve também `accent_text`, derivado). */
export function pickSettings(s) {
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, s[k] ?? DEFAULTS[k]]))
}

// O login ainda não sabe quem vai entrar: usa o último perfil deste dispositivo
// (escolhe o ecrã inicial e a cor das caixas). Sobrevive ao logout, ao contrário da cache.
const LOOK_KEY = 'rag.loginLook'

export function rememberLoginLook(look) {
  try {
    const prev = loginLook() || {}
    localStorage.setItem(LOOK_KEY, JSON.stringify({ ...prev, ...look }))
  } catch {
    /* modo privado */
  }
}

export function loginLook() {
  try {
    const raw = localStorage.getItem(LOOK_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
