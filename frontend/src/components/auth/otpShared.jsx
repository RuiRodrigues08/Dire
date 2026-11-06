import { useCallback, useEffect, useRef, useState } from 'react'
// Fontes locais: a CSP do backend (style-src 'self') bloqueia o Google Fonts.
import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/500.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import '@fontsource/plus-jakarta-sans/800.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'

/*
  Peças comuns aos dois ecrãs de verificação (EncriptacaoVerify e LoveVerify):
  temas, ícones, marca e a lógica do código (input invisível → POST /api/auth/login).
*/

export const LEN = 4
export const TILE = 56
export const GAP = 12
export const ROW_WIDTH = LEN * TILE + (LEN - 1) * GAP

export const RED = '#ff3b30'
export const GREEN = '#22c55e'

export const THEMES = {
  dark: {
    bg: '#0d0a0e',
    card: 'linear-gradient(180deg,#1c181d 0%,#151216 100%)',
    cardBorder: 'rgba(255,255,255,0.05)',
    cardShadow: '0 30px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.04)',
    text: '#f4f1f4',
    muted: '#7c7579',
    tile: 'linear-gradient(180deg,#221e23,#1a171b)',
    tileBorder: 'rgba(255,255,255,0.06)',
    iconBtn: '#221e23',
    scan: 'rgba(255,255,255,.14)',
  },
  light: {
    bg: '#efecef',
    card: 'linear-gradient(180deg,#ffffff 0%,#f7f5f7 100%)',
    cardBorder: 'rgba(0,0,0,0.06)',
    cardShadow: '0 30px 80px rgba(40,20,30,.15), inset 0 1px 0 #fff',
    text: '#1a1619',
    muted: '#8a8287',
    tile: 'linear-gradient(180deg,#f6f3f5,#ece8eb)',
    tileBorder: 'rgba(0,0,0,0.07)',
    iconBtn: '#f1edf0',
    scan: 'rgba(255,255,255,.75)',
  },
}

const RED_RGB = '255 59 48'

/**
 * Cor das caixas enquanto se escreve, como "R G B" para a variável CSS --otp-c:
 * a cor de destaque do perfil, ou vermelho enquanto houver um erro.
 */
export function typingColor(accent, error) {
  if (error || !/^#[0-9a-f]{6}$/i.test(accent || '')) return RED_RGB
  const n = parseInt(accent.slice(1), 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/** Estilo da caixa ativa (a que recebe o próximo dígito). */
export const ACTIVE_TILE_BG = 'radial-gradient(circle at 50% 50%, rgb(var(--otp-c) / .18), rgb(var(--otp-c) / .04))'

// Ecrã de login: escuro por omissão; a escolha feita no botão fica guardada neste dispositivo.
const LOGIN_THEME_KEY = 'rag.loginTheme'
export const initialLoginTheme = () => {
  try {
    const v = localStorage.getItem(LOGIN_THEME_KEY)
    return v === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}
export const saveLoginTheme = (t) => {
  try {
    localStorage.setItem(LOGIN_THEME_KEY, t)
  } catch {
    /* modo privado */
  }
}

export const BASE_CSS = `
.otp-root *{box-sizing:border-box}
.otp-root{font-family:'Plus Jakarta Sans',system-ui,sans-serif}
.otp-mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
@keyframes otp-blink{0%,45%{opacity:1}50%,100%{opacity:0}}
@keyframes otp-pulse{0%,100%{box-shadow:0 0 0 1.5px rgb(var(--otp-c)),0 0 18px rgb(var(--otp-c) / .35),inset 0 0 14px rgb(var(--otp-c) / .25)}50%{box-shadow:0 0 0 1.5px rgb(var(--otp-c)),0 0 28px rgb(var(--otp-c) / .55),inset 0 0 22px rgb(var(--otp-c) / .4)}}
@keyframes otp-pop{0%{transform:scale(.8);opacity:0}100%{transform:scale(1);opacity:1}}
@keyframes otp-fadeup{0%{transform:translateY(8px);opacity:0}100%{transform:translateY(0);opacity:1}}
@keyframes otp-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-9px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(3px)}}
@keyframes otp-dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%,100%{content:'...'}}
.otp-dots::after{content:'...';display:inline-block;width:1.1em;text-align:left;animation:otp-dots 1.2s steps(1) infinite}
`

/* ---------- Ícones ---------- */
function SunIcon({ color }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} x1="12" y1="2.5" x2="12" y2="4.5" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  )
}

function MoonIcon({ color }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

/* ---------- Cabeçalho: logo + nome à esquerda, tema à direita ---------- */
export function CardHeader({ theme, onToggleTheme }) {
  const t = THEMES[theme]
  return (
    <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <img
          src="/logo-badge.png" alt="" width={52} height={52}
          style={{ display: 'block', borderRadius: 12 }}
        />
        <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-.02em', color: t.text, transition: 'color .4s' }}>
          Dire
        </span>
      </div>
      <button
        type="button"
        aria-label="Mudar tema"
        onClick={(e) => { e.stopPropagation(); onToggleTheme() }}
        style={{ width: 36, height: 36, borderRadius: 11, border: `1px solid ${t.tileBorder}`, background: t.iconBtn, display: 'grid', placeItems: 'center', cursor: 'pointer' }}
      >
        {theme === 'dark' ? <SunIcon color={t.text} /> : <MoonIcon color={t.text} />}
      </button>
    </div>
  )
}

/* ---------- Rodapé ---------- */
export function CardFooter({ phase, theme, onClear }) {
  const t = THEMES[theme]
  const success = phase === 'success'
  return (
    <div key={success ? 's' : 'r'} style={{ fontSize: 14, animation: 'otp-fadeup .45s ease both' }}>
      {success ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: GREEN, fontWeight: 600 }}>
          <LockIcon /> Verificado e seguro
        </span>
      ) : (
        <span style={{ color: t.muted }}>
          Enganaste-te?{' '}
          <button
            type="button"
            disabled={phase !== 'input'}
            onClick={(e) => { e.stopPropagation(); onClear() }}
            style={{ color: 'rgb(var(--otp-c))', fontWeight: 600, background: 'none', border: 0, padding: 0, font: 'inherit', cursor: phase === 'input' ? 'pointer' : 'default', opacity: phase === 'input' ? 1 : 0.4 }}
          >
            Limpar
          </button>
        </span>
      )}
    </div>
  )
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Estado comum: input → checking (pedido ao servidor) → verifying (animação) → success,
 * ou, se o código for recusado, checking → failing (a mesma animação, mas a falhar) → input.
 *
 * - `submit(code)` faz o login. Devolve true para este ecrã animar, false se o ecrã
 *   vai ser trocado pelo outro (perfil diferente). Erros (código errado, bloqueio)
 *   são lançados e mostrados aqui, depois da animação de falha.
 * - `initialCode`: o login já foi feito noutro ecrã; arranca logo em "verifying".
 * - `finish()` é chamado pelo ecrã quando a animação acaba; `onVerified` corre
 *   `holdMs` depois, para se ver o sucesso antes de entrar na app.
 * - `fail()` é chamado pelo ecrã no fim da animação de falha: mostra o erro e limpa o código.
 */
export function useOtpFlow({ submit, onVerified, initialCode, startDelay, holdMs }) {
  const [code, setCode] = useState(initialCode || '')
  const [phase, setPhase] = useState(initialCode ? 'verifying' : 'input')
  const [error, setError] = useState(null) // { message, locked }
  const [shake, setShake] = useState(0)
  const [focused, setFocused] = useState(true)
  const inputRef = useRef(null)
  const mounted = useRef(false)
  const holdTimer = useRef(0)
  const pendingError = useRef(null)

  const submitRef = useRef(submit)
  submitRef.current = submit
  const onVerifiedRef = useRef(onVerified)
  onVerifiedRef.current = onVerified

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(holdTimer.current)
    }
  }, [])

  useEffect(() => {
    if (phase === 'input') inputRef.current?.focus()
  }, [phase])

  async function check(value) {
    setPhase('checking')
    // a pausa depois do 4.º dígito corre em paralelo com o pedido (também quando falha)
    const result = submitRef.current(value).then((go) => ({ go }), (err) => ({ err }))
    await wait(startDelay)
    const { go, err } = await result
    if (!mounted.current) return
    if (err) {
      pendingError.current = { message: err.message || 'Não foi possível verificar o código.', locked: err.status === 429 }
      setPhase('failing')
    } else if (go) setPhase('verifying')
  }

  const fail = useCallback(() => {
    setError(pendingError.current)
    setShake((n) => n + 1)
    setCode('')
    setPhase('input')
  }, [])

  const onChange = (e) => {
    if (phase !== 'input') return
    const v = e.target.value.replace(/\D/g, '').slice(0, LEN)
    setCode(v)
    if (v) setError(null)
    if (v.length === LEN) check(v)
  }

  const clear = () => {
    setCode('')
    setError(null)
    setTimeout(() => inputRef.current?.focus(), 30)
  }

  const finish = useCallback(() => {
    setPhase('success')
    holdTimer.current = setTimeout(() => onVerifiedRef.current?.(), holdMs)
  }, [holdMs])

  const inputProps = {
    ref: inputRef,
    value: code,
    onChange,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    inputMode: 'numeric',
    autoComplete: 'one-time-code',
    maxLength: LEN,
    autoFocus: true,
    disabled: phase !== 'input',
    'aria-label': 'Código de acesso',
    'aria-invalid': !!error,
    style: { position: 'absolute', opacity: 0, width: 1, height: 1, pointerEvents: 'none' },
  }

  return { code, phase, error, shake, focused, inputRef, inputProps, clear, finish, fail }
}
