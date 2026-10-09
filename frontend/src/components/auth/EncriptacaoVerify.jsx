import { useEffect, useState } from 'react'
import {
  ACTIVE_TILE_BG, BASE_CSS, CardFooter, CardHeader, GAP, GREEN, LEN, RED, ROW_WIDTH, THEMES, TILE, typingColor, useOtpFlow,
} from './otpShared'

/*
  EncriptacaoVerify — "Decrypter" (estilo terminal), ecrã do admin.
  Fases: "input" → "checking" (servidor) → "verifying" (dígitos cifrados + barra de luz) → "success"
  As caixas nunca saem do sítio. No fim, cada dígito "tranca" da esquerda
  para a direita no valor original, em verde, e a borda acende-se.
  Código errado: "failing" faz a mesma cifra, mais curta, e os dígitos trancam a vermelho
  ("ACCESS DENIED"); depois as caixas abanam e limpam.
*/

const START_DELAY = 350 // pausa mínima depois do 4.º dígito
const VERIFY_MS = 1300 // tempo de cifra antes de começar a trancar
const LOCK_STEP = 180 // intervalo entre cada dígito trancar
const SCRAMBLE_MS = 50 // velocidade da troca de símbolos
const HOLD_MS = 800 // tempo a mostrar o sucesso antes de entrar
const FAIL_MS = 1000 // tempo de cifra antes de recusar
const DENY_STEP = 120 // intervalo entre cada dígito recusar
const DENIED_HOLD = 700 // tempo a mostrar "ACCESS DENIED" antes de voltar ao início
const GLYPHS = '*#@%&$!?<>/\\=+0123456789'

const CSS = `
${BASE_CSS}
@keyframes otp-scan{0%{transform:translateX(-100%)}100%{transform:translateX(${Math.ceil(100 / 0.35) + 100}%)}}
@keyframes otp-lock{0%{transform:scale(1.18);filter:brightness(1.8)}60%{transform:scale(.97)}100%{transform:scale(1);filter:brightness(1)}}
@keyframes otp-flash{0%{opacity:.55}100%{opacity:0}}
@media (prefers-reduced-motion: reduce){.otp-scanbar{display:none}}
`

const randGlyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0]
const randRow = () => Array.from({ length: LEN }, randGlyph)

export default function EncriptacaoVerify({ submit, onVerified, initialCode, greeting, notice, theme, onToggleTheme, accent, backdrop }) {
  const { code, phase, error, shake, focused, inputRef, inputProps, clear, finish, fail } = useOtpFlow({
    submit, onVerified, initialCode, startDelay: START_DELAY, holdMs: HOLD_MS,
  })
  const [locked, setLocked] = useState(0) // quantos dígitos já trancaram
  const [denied, setDenied] = useState(0) // quantos dígitos já foram recusados (código errado)
  const [glyphs, setGlyphs] = useState(randRow)
  const t = THEMES[theme]

  // Sequência (login já aceite): cifra → tranca um a um → sucesso
  useEffect(() => {
    if (phase !== 'verifying') return
    const timers = []
    for (let i = 0; i < LEN; i++) {
      timers.push(setTimeout(() => setLocked(i + 1), VERIFY_MS + i * LOCK_STEP))
    }
    timers.push(setTimeout(finish, VERIFY_MS + (LEN - 1) * LOCK_STEP + 450))
    return () => timers.forEach(clearTimeout)
  }, [phase, finish])

  // Código recusado: cifra → recusa um a um → volta ao início
  useEffect(() => {
    if (phase === 'input') setDenied(0)
    if (phase !== 'failing') return
    const timers = []
    for (let i = 0; i < LEN; i++) {
      timers.push(setTimeout(() => setDenied(i + 1), FAIL_MS + i * DENY_STEP))
    }
    timers.push(setTimeout(fail, FAIL_MS + (LEN - 1) * DENY_STEP + DENIED_HOLD))
    return () => timers.forEach(clearTimeout)
  }, [phase, fail])

  // Troca frenética de símbolos enquanto há dígitos por trancar (ou por recusar)
  const scrambling = (phase === 'verifying' && locked < LEN) || (phase === 'failing' && denied < LEN)
  useEffect(() => {
    if (!scrambling) return
    const id = setInterval(() => setGlyphs(randRow()), SCRAMBLE_MS)
    return () => clearInterval(id)
  }, [scrambling])

  const inInput = phase === 'input'
  const checking = phase === 'checking'
  const verifying = phase === 'verifying'
  const success = phase === 'success'
  const failing = phase === 'failing'
  const deniedAll = failing && denied === LEN

  const titles = {
    input: { h: 'Introduz o teu código', p: <>Código de acesso de 4 dígitos.<br />Verifica automaticamente ao terminar.</> },
    verifying: { h: <span>A desencriptar<span className="otp-dots" style={{ display: 'inline' }} /></span>, p: 'A processar a autenticação segura' },
    success: { h: 'Acesso concedido', p: greeting ? `Olá de novo, ${greeting}.` : 'Código verificado.' },
    denied: { h: 'Acesso negado', p: 'Não foi possível confirmar o código.' },
  }
  const tk = checking ? 'input' : deniedAll ? 'denied' : failing ? 'verifying' : phase

  const progress = '#'.repeat(locked) + '·'.repeat(LEN - locked)
  let status = null
  let statusColor = t.muted
  if (success) { status = '> ACCESS GRANTED'; statusColor = GREEN }
  else if (verifying) status = `> DECRYPTING [${progress}] ${locked}/${LEN}`
  else if (deniedAll) { status = '> ACCESS DENIED'; statusColor = RED }
  else if (failing) status = `> DECRYPTING [${'x'.repeat(denied) + '·'.repeat(LEN - denied)}] ${denied}/${LEN}`
  else if (checking) status = <>{'> A VERIFICAR'}<span className="otp-dots" /></>
  else if (error) { status = `> ${error.message}`; statusColor = error.locked ? '#f59e0b' : RED }
  else if (notice) status = notice

  return (
    <div className="otp-root" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: backdrop ? `${backdrop}, ${t.bg}` : t.bg, transition: 'background .4s', padding: 16, overflow: 'hidden', '--otp-c': typingColor(accent, error) }}>
      <style>{CSS}</style>

      <div
        style={{
          position: 'relative', width: '100%', maxWidth: 420, height: 490, borderRadius: 28,
          background: t.card, border: `1px solid ${t.cardBorder}`, boxShadow: t.cardShadow,
          padding: '20px 22px 30px', display: 'flex', flexDirection: 'column', alignItems: 'center',
          transition: 'background .4s, box-shadow .4s',
        }}
        onClick={() => inInput && inputRef.current?.focus()}
      >
        <CardHeader theme={theme} onToggleTheme={onToggleTheme} />

        {/* títulos */}
        <div key={tk} style={{ textAlign: 'center', marginTop: 22, animation: 'otp-fadeup .45s ease both' }}>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-.01em', color: success ? GREEN : deniedAll ? RED : t.text, transition: 'color .4s' }}>{titles[tk].h}</h2>
          <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.6, color: t.muted }}>{titles[tk].p}</p>
        </div>

        {/* palco */}
        <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
          <div key={shake} style={{ position: 'relative', width: ROW_WIDTH, height: TILE, display: 'flex', gap: GAP, animation: shake ? 'otp-shake .45s ease' : 'none' }}>
            {Array.from({ length: LEN }).map((_, i) => {
              const ch = code[i]
              const isLocked = i < locked
              const isDenied = failing && i < denied
              const isScrambling = (verifying && !isLocked) || (failing && !isDenied)
              const active = inInput && focused && i === Math.min(code.length, LEN - 1) && (code.length < LEN || i === LEN - 1)

              let shadow = '0 6px 16px rgba(0,0,0,.25)'
              if (isLocked) shadow = '0 0 0 1.5px rgba(34,197,94,.7), 0 0 16px rgba(34,197,94,.28), inset 0 0 12px rgba(34,197,94,.12)'
              else if (isDenied) shadow = '0 0 0 1.5px rgba(255,59,48,.75), 0 0 16px rgba(255,59,48,.3), inset 0 0 12px rgba(255,59,48,.14)'
              else if (isScrambling) shadow = '0 0 0 1px rgba(255,59,48,.35), 0 6px 16px rgba(0,0,0,.25)'
              else if (error && inInput) shadow = '0 0 0 1px rgba(255,59,48,.5), 0 6px 16px rgba(0,0,0,.25)'

              return (
                <div key={i} style={{
                  position: 'relative', overflow: 'hidden', width: TILE, height: TILE, borderRadius: 16,
                  display: 'grid', placeItems: 'center',
                  background: active ? ACTIVE_TILE_BG : t.tile,
                  border: `1px solid ${t.tileBorder}`,
                  boxShadow: active ? undefined : shadow,
                  animation: active ? 'otp-pulse 1.6s ease-in-out infinite' : 'none',
                  transition: 'box-shadow .45s, background .3s',
                }}>
                  {isLocked ? (
                    <>
                      <span key={'l' + i} className="otp-mono" style={{ fontSize: 26, fontWeight: 700, color: GREEN, textShadow: '0 0 10px rgba(34,197,94,.45)', animation: 'otp-lock .4s cubic-bezier(.34,1.4,.64,1) both' }}>{ch}</span>
                      <span style={{ position: 'absolute', inset: 0, background: 'rgba(34,197,94,.35)', animation: 'otp-flash .5s ease-out forwards', pointerEvents: 'none' }} />
                    </>
                  ) : isDenied ? (
                    <>
                      <span key={'d' + i} className="otp-mono" style={{ fontSize: 26, fontWeight: 700, color: RED, textShadow: '0 0 10px rgba(255,59,48,.45)', animation: 'otp-lock .4s cubic-bezier(.34,1.4,.64,1) both' }}>{ch}</span>
                      <span style={{ position: 'absolute', inset: 0, background: 'rgba(255,59,48,.35)', animation: 'otp-flash .5s ease-out forwards', pointerEvents: 'none' }} />
                    </>
                  ) : isScrambling ? (
                    <span className="otp-mono" style={{ fontSize: 24, fontWeight: 500, color: t.muted, opacity: 0.6 + Math.random() * 0.4 }}>{glyphs[i]}</span>
                  ) : ch ? (
                    <span key={ch + i} className="otp-mono" style={{ fontSize: 26, fontWeight: 700, color: t.text, animation: 'otp-pop .25s ease both' }}>{ch}</span>
                  ) : active ? (
                    <span style={{ width: 2, height: 22, borderRadius: 2, background: 'rgb(var(--otp-c))', animation: 'otp-blink 1s infinite' }} />
                  ) : null}
                </div>
              )
            })}

            {/* barra de luz que varre as caixas */}
            {scrambling && (
              <div style={{ position: 'absolute', inset: '-8px 0', overflow: 'hidden', borderRadius: 18, pointerEvents: 'none' }}>
                <div className="otp-scanbar" style={{
                  position: 'absolute', top: 0, bottom: 0, left: 0, width: '35%',
                  background: `linear-gradient(90deg, transparent, ${t.scan}, transparent)`,
                  mixBlendMode: theme === 'dark' ? 'screen' : 'normal',
                  animation: 'otp-scan 1.3s cubic-bezier(.45,0,.55,1) infinite',
                }} />
              </div>
            )}
          </div>

          {/* linha de estado estilo terminal (também mostra erros) */}
          <div
            className="otp-mono"
            role={error ? 'alert' : undefined}
            style={{
              fontSize: 12, letterSpacing: '.04em', minHeight: 16, maxWidth: '100%', textAlign: 'center', lineHeight: 1.5,
              color: statusColor, opacity: status ? 1 : 0, transition: 'opacity .3s, color .3s',
            }}
          >
            {status}
          </div>
        </div>

        <CardFooter phase={phase} theme={theme} onClear={clear} />

        {/* input real (invisível) */}
        <input {...inputProps} />
      </div>
    </div>
  )
}
