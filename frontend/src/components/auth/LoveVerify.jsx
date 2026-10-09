import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ACTIVE_TILE_BG, BASE_CSS, CardFooter, CardHeader, GAP, LEN, RED, THEMES, TILE, typingColor, useOtpFlow,
} from './otpShared'

/*
  LoveVerify — ecrã de verificação do perfil não-admin.
  Fases: "input" → "checking" (servidor) → "verifying" (dígitos formam um coração,
  percorrem-no e descem em espiral até ao centro, a desaparecer) → "success"
  (corações + coração "16").
  Código errado: "failing" faz o mesmo percurso pelo coração, mas no fim o coração
  parte-se ao meio e os dígitos caem; depois voltam ao sítio, vazios.
*/

const TILE_S = 0.62 // escala das caixas no coração
const START_DELAY = 650 // pausa mínima depois do 4.º dígito
const HOLD_MS = 2200 // tempo a mostrar o sucesso antes de entrar

// tempos da fase "verifying" (ms)
const T_IN = 700 // caixas viajam para o coração
const T_TRAVEL = 2300 // fim do percurso ao longo do coração
const T_END = 3900 // fim da espiral
const T_FAIL_END = T_TRAVEL + 1200 // fim da queda (código errado)

const HEART_K = 4.4 // escala da curva do coração
const HEART_T0 = [-0.75, -0.25, 0.25, 0.75].map((v) => v * Math.PI) // posição inicial de cada dígito na curva
const TRAVEL_W = (0.9 * Math.PI) / (T_TRAVEL - T_IN) // velocidade ao longo da curva

const PINK = '#ff5c8a'

// forma de coração (viewBox 0 0 24 24)
const HEART_SVG = 'M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3 1.7-1.9 3.2-3 5.3-3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z'

const CSS = `
${BASE_CSS}
@keyframes otp-spin{to{transform:rotate(360deg)}}
@keyframes otp-heart-pop{0%{transform:scale(0) rotate(-18deg);opacity:0}50%{transform:scale(1.28) rotate(6deg);opacity:1}72%{transform:scale(.9) rotate(-2deg)}88%{transform:scale(1.06)}100%{transform:scale(1) rotate(0)}}
@keyframes otp-beat{0%,60%,100%{transform:scale(1)}12%{transform:scale(1.1)}24%{transform:scale(1)}36%{transform:scale(1.07)}}
@keyframes otp-ring-in{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}
@keyframes otp-glint{0%{transform:translateX(-120%) rotate(25deg)}100%{transform:translateX(220%) rotate(25deg)}}
`

/* ---------- Geometria ---------- */
const lerp = (a, b, p) => a + (b - a) * p
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3)
const clamp01 = (v) => Math.max(0, Math.min(1, v))

// curva paramétrica do coração, centrada em (0,0)
function heartPoint(t) {
  const s = Math.sin(t)
  return {
    x: 16 * s * s * s * HEART_K,
    y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * HEART_K - 2.5 * HEART_K,
  }
}

const HEART_OUTLINE = (() => {
  const pts = []
  for (let k = 0; k <= 160; k++) {
    const p = heartPoint((k / 160) * Math.PI * 2)
    pts.push(`${k ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
  }
  return pts.join(' ') + 'Z'
})()

function inputPos(i) {
  const total = LEN * TILE + (LEN - 1) * GAP
  return { x: -total / 2 + TILE / 2 + i * (TILE + GAP), y: 0 }
}

// posição de cada caixa ao longo da fase "verifying" (e = ms decorridos)
function tileAnim(i, e) {
  const t0 = HEART_T0[i]
  if (e < T_IN) {
    const p = easeOutCubic(e / T_IN)
    const a = inputPos(i), h = heartPoint(t0)
    return { x: lerp(a.x, h.x, p), y: lerp(a.y, h.y, p), s: lerp(1, TILE_S, p), o: 1, rot: 0 }
  }
  if (e < T_TRAVEL) {
    const h = heartPoint(t0 + TRAVEL_W * (e - T_IN))
    return { ...h, s: TILE_S, o: 1, rot: 0 }
  }
  // espiral para o centro, cada vez mais rápida, a desaparecer
  const q = clamp01((e - T_TRAVEL) / (T_END - T_TRAVEL))
  const h = heartPoint(t0 + TRAVEL_W * (T_TRAVEL - T_IN))
  const r0 = Math.hypot(h.x, h.y), a0 = Math.atan2(h.y, h.x)
  const r = r0 * Math.pow(1 - q, 1.3)
  const a = a0 + Math.PI * (1.2 * q + 2.6 * q * q)
  return {
    x: Math.cos(a) * r, y: Math.sin(a) * r,
    s: TILE_S * (1 - 0.75 * q),
    o: 1 - Math.pow(q, 1.3),
    rot: q * 300,
  }
}

// código errado: a partir do fim do percurso, cada caixa cai para fora do cartão a rodar
function tileFall(i, e) {
  if (e < T_TRAVEL) return tileAnim(i, e)
  const q = clamp01((e - T_TRAVEL) / (T_FAIL_END - T_TRAVEL))
  const h = heartPoint(HEART_T0[i] + TRAVEL_W * (T_TRAVEL - T_IN))
  const dir = h.x < 0 ? -1 : 1
  return {
    x: h.x + dir * 50 * q,
    y: h.y - 30 * q + 320 * q * q,
    s: TILE_S,
    o: 1 - Math.pow(q, 2),
    rot: dir * (40 + i * 25) * q,
  }
}

// fenda do coração partido (de cima a baixo) e as duas metades recortadas por ela
const CRACK = [[0, -40], [-8, -22], [7, -6], [-6, 12], [6, 30], [-3, 48], [0, 80]]
const CRACK_PATH = CRACK.map(([x, y], k) => `${k ? 'L' : 'M'}${x} ${y}`).join(' ')
const HALF_CLIP = {
  left: `M-130 -130 L0 -130 ${CRACK.map(([x, y]) => `L${x} ${y}`).join(' ')} L0 130 L-130 130Z`,
  right: `M130 -130 L0 -130 ${CRACK.map(([x, y]) => `L${x} ${y}`).join(' ')} L0 130 L130 130Z`,
}

/* ---------- Corações pequeninos (canvas) ---------- */
function useHeartBurst() {
  const canvasRef = useRef(null)
  const raf = useRef(0)

  const burst = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth, h = c.clientHeight
    c.width = w * dpr; c.height = h * dpr
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const shape = new Path2D(HEART_SVG)
    const cx = w / 2, cy = h / 2
    const colors = [RED, PINK, '#ff8fab', '#ffb3c6', '#e11d48', '#ffffff', '#ff6b5e']
    const parts = Array.from({ length: 90 }, () => {
      const a = Math.random() * Math.PI * 2
      const s = 2 + Math.random() * 7.5
      return {
        x: cx + Math.cos(a) * 24, y: cy + Math.sin(a) * 24,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1,
        size: 6 + Math.random() * 11,
        rot: (Math.random() - 0.5) * 0.8, vr: (Math.random() - 0.5) * 0.06,
        sway: Math.random() * Math.PI * 2,
        c: colors[(Math.random() * colors.length) | 0],
        life: 0, max: 90 + Math.random() * 90,
      }
    })
    cancelAnimationFrame(raf.current)
    const tick = () => {
      ctx.clearRect(0, 0, w, h)
      let alive = 0
      for (const p of parts) {
        p.life++
        if (p.life > p.max) continue
        alive++
        p.vx *= 0.955; p.vy = p.vy * 0.955 - 0.035 // flutuam para cima
        p.x += p.vx + Math.sin(p.life * 0.08 + p.sway) * 0.35
        p.y += p.vy
        p.rot += p.vr
        const fadeIn = Math.min(1, p.life / 6)
        ctx.globalAlpha = fadeIn * Math.max(0, 1 - p.life / p.max)
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.scale(p.size / 24, p.size / 24)
        ctx.translate(-12, -12.5)
        ctx.fillStyle = p.c
        ctx.fill(shape)
        ctx.restore()
      }
      ctx.globalAlpha = 1
      if (alive) raf.current = requestAnimationFrame(tick)
    }
    tick()
  }, [])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])
  return { canvasRef, burst }
}

/* ---------- Componente principal ---------- */
export default function LoveVerify({ submit, onVerified, initialCode, greeting, notice, theme, onToggleTheme, accent, backdrop }) {
  const { code, phase, error, shake, focused, inputRef, inputProps, clear, finish, fail } = useOtpFlow({
    submit, onVerified, initialCode, startDelay: START_DELAY, holdMs: HOLD_MS,
  })
  const [elapsed, setElapsed] = useState(0)
  const { canvasRef, burst } = useHeartBurst()
  const t = THEMES[theme]

  // Animação coração → espiral (login aceite) ou coração → partido (código errado)
  useEffect(() => {
    if (phase !== 'verifying' && phase !== 'failing') return
    const failing = phase === 'failing'
    const end = failing ? T_FAIL_END : T_END
    let raf
    const start = performance.now()
    const loop = (now) => {
      const e = now - start
      if (e >= end) {
        setElapsed(0)
        if (failing) {
          fail()
        } else {
          setElapsed(T_END)
          finish()
          burst()
        }
        return
      }
      setElapsed(e)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase, burst, finish, fail])

  const inInput = phase === 'input'
  const checking = phase === 'checking'
  const verifying = phase === 'verifying'
  const success = phase === 'success'
  const failing = phase === 'failing'
  const broken = failing && elapsed >= T_TRAVEL
  const animating = verifying || failing

  const titles = {
    input: { h: 'Introduz o teu código', p: <>Código de acesso de 4 dígitos.<br />Verifica automaticamente ao terminar.</> },
    verifying: { h: <span>A verificar<span className="otp-dots" style={{ display: 'inline' }} /></span>, p: 'A processar a autenticação segura' },
    success: { h: 'Verificado com sucesso', p: greeting ? `Olá, ${greeting} ♥` : 'Código verificado.' },
    broken: { h: 'Não foi desta', p: 'O código não foi aceite.' },
  }
  const tk = checking ? 'input' : broken ? 'broken' : failing ? 'verifying' : phase

  let message = null
  let messageColor = t.muted
  if (error && inInput) { message = error.message; messageColor = error.locked ? '#f59e0b' : RED }
  else if (notice && inInput) message = notice

  // contorno do coração: desenha-se, bate, e encolhe/desaparece durante a espiral
  const spiralQ = verifying ? clamp01((elapsed - T_TRAVEL) / (T_END - T_TRAVEL)) : 0
  const breakQ = failing ? clamp01((elapsed - T_TRAVEL) / (T_FAIL_END - T_TRAVEL)) : 0
  const outlineDraw = clamp01(elapsed / (T_IN + 500))
  const outlineOpacity = animating ? Math.min(clamp01(elapsed / T_IN), 1 - spiralQ) : 0
  const beat = 1 + 0.06 * Math.pow(Math.max(0, Math.sin((elapsed * 2 * Math.PI) / 900)), 6)
  const outlineScale = beat * (1 - 0.35 * spiralQ)

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
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-.01em', color: success || broken ? RED : t.text, transition: 'color .4s' }}>{titles[tk].h}</h2>
          <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.6, color: t.muted }}>{titles[tk].p}</p>
        </div>

        {/* palco */}
        <div style={{ position: 'relative', flex: 1, width: '100%', display: 'grid', placeItems: 'center' }}>
          <div key={shake} style={{ position: 'relative', width: 0, height: 0, animation: shake ? 'otp-shake .45s ease' : 'none' }}>
            {/* coração partido: as duas metades afastam-se, rodam e caem */}
            {broken && (
              <svg
                width="220" height="220" viewBox="-110 -110 220 220"
                style={{ position: 'absolute', left: -110, top: -110, overflow: 'visible', pointerEvents: 'none', opacity: 1 - breakQ }}
              >
                <defs>
                  <clipPath id="otpHalfL"><path d={HALF_CLIP.left} /></clipPath>
                  <clipPath id="otpHalfR"><path d={HALF_CLIP.right} /></clipPath>
                </defs>
                {[['L', -1], ['R', 1]].map(([side, dir]) => (
                  <g key={side} transform={`translate(${dir * 26 * breakQ} ${90 * breakQ * breakQ}) rotate(${dir * 16 * breakQ} 0 60)`}>
                    <g clipPath={`url(#otpHalf${side})`}>
                      <path d={HEART_OUTLINE} fill="rgba(255,59,48,.06)" stroke="rgba(255,59,48,.55)" strokeWidth="1.5" />
                      <path d={CRACK_PATH} fill="none" stroke="rgba(255,59,48,.8)" strokeWidth="2" strokeLinejoin="round" />
                    </g>
                  </g>
                ))}
              </svg>
            )}

            {/* contorno do coração */}
            {!broken && <svg
              width="220" height="220" viewBox="-110 -110 220 220"
              style={{
                position: 'absolute', left: -110, top: -110, overflow: 'visible', pointerEvents: 'none',
                opacity: outlineOpacity, transform: `scale(${outlineScale})`,
              }}
            >
              <path d={HEART_OUTLINE} fill="rgba(255,59,48,.06)" stroke="rgba(255,59,48,.45)" strokeWidth="1.5"
                pathLength="1" strokeDasharray="1" strokeDashoffset={1 - outlineDraw}
                style={{ filter: 'drop-shadow(0 0 8px rgba(255,59,48,.35))' }} />
            </svg>}

            {/* brilho no centro enquanto os dígitos são "engolidos" */}
            {verifying && spiralQ > 0 && (
              <div style={{
                position: 'absolute', left: -40, top: -40, width: 80, height: 80, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(255,92,138,.85), rgba(255,59,48,.25) 40%, transparent 70%)',
                opacity: spiralQ, transform: `scale(${0.3 + spiralQ})`, pointerEvents: 'none',
              }} />
            )}

            {/* caixas */}
            {Array.from({ length: LEN }).map((_, i) => {
              const ch = code[i]
              const active = inInput && focused && i === Math.min(code.length, LEN - 1) && (code.length < LEN || i === LEN - 1)
              let p
              if (verifying) p = tileAnim(i, elapsed)
              else if (failing) p = tileFall(i, elapsed)
              else if (success) p = { x: 0, y: 0, s: 0, o: 0, rot: 0 }
              else p = { ...inputPos(i), s: 1, o: 1, rot: 0 }
              return (
                <div key={i} style={{
                  position: 'absolute', left: -TILE / 2, top: -TILE / 2, width: TILE, height: TILE,
                  transform: `translate(${p.x}px, ${p.y}px) scale(${p.s}) rotate(${p.rot}deg)`,
                  opacity: p.o,
                  transition: inInput ? `transform .55s cubic-bezier(.34,1.3,.5,1) ${i * 50}ms, opacity .3s` : 'none',
                }}>
                  <div style={{
                    position: 'relative', overflow: 'hidden', width: '100%', height: '100%', borderRadius: 16,
                    display: 'grid', placeItems: 'center',
                    background: active ? ACTIVE_TILE_BG : t.tile,
                    border: `1px solid ${t.tileBorder}`,
                    boxShadow: animating
                      ? `0 0 0 2px ${RED}, 0 0 16px rgba(255,59,48,.45)`
                      : active ? undefined
                        : error && inInput ? '0 0 0 1px rgba(255,59,48,.5), 0 6px 16px rgba(0,0,0,.25)'
                          : '0 6px 16px rgba(0,0,0,.25)',
                    animation: active ? 'otp-pulse 1.6s ease-in-out infinite' : 'none',
                    transition: 'box-shadow .4s, background .3s',
                  }}>
                    {ch ? (
                      <span key={ch + i} style={{ fontSize: 26, fontWeight: 700, color: t.text, animation: 'otp-pop .25s ease both' }}>{ch}</span>
                    ) : active ? (
                      <span style={{ width: 2, height: 22, borderRadius: 2, background: 'rgb(var(--otp-c))', animation: 'otp-blink 1s infinite' }} />
                    ) : null}
                    {animating && !broken && (
                      <>
                        <span style={{ position: 'absolute', top: -10, right: -10, width: 30, height: 30, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,59,48,.9), transparent 65%)' }} />
                        <span style={{ position: 'absolute', inset: 0, width: '40%', background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.25),transparent)', animation: `otp-glint 1.6s ease-in-out ${i * 0.2}s infinite` }} />
                      </>
                    )}
                  </div>
                </div>
              )
            })}

            {/* sucesso: coração com 16 */}
            {success && (
              <>
                <div style={{ position: 'absolute', left: -102, top: -102, width: 204, height: 204, borderRadius: '50%', border: '1.5px dashed rgba(255,92,138,.45)', animation: 'otp-ring-in .6s ease both, otp-spin 14s linear infinite' }} />
                <div style={{ position: 'absolute', left: -84, top: -84, width: 168, height: 168, borderRadius: '50%', border: '1.5px solid rgba(255,59,48,.18)', animation: 'otp-ring-in .5s .05s ease both' }} />
                <div style={{ position: 'absolute', left: -60, top: -60, width: 120, height: 120, animation: 'otp-heart-pop .75s cubic-bezier(.34,1.56,.64,1) both' }}>
                  <div style={{ width: '100%', height: '100%', animation: 'otp-beat 1.3s .9s ease-in-out infinite', filter: 'drop-shadow(0 12px 28px rgba(255,59,48,.5))' }}>
                    <svg width="120" height="120" viewBox="0 0 24 24">
                      <defs>
                        <linearGradient id="otpHeartGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#ff6b8b" />
                          <stop offset="100%" stopColor="#e0242f" />
                        </linearGradient>
                        <linearGradient id="otpHeartShine" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="rgba(255,255,255,.35)" />
                          <stop offset="60%" stopColor="rgba(255,255,255,0)" />
                        </linearGradient>
                      </defs>
                      <path d={HEART_SVG} fill="url(#otpHeartGrad)" />
                      <path d={HEART_SVG} fill="url(#otpHeartShine)" />
                      <text x="12" y="13.1" textAnchor="middle" dominantBaseline="middle"
                        fontFamily="'Plus Jakarta Sans',system-ui,sans-serif" fontSize="6.6" fontWeight="800" fill="#fff"
                        style={{ letterSpacing: '-.02em' }}>16</text>
                    </svg>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* erros e avisos, por baixo das caixas */}
          <div
            role={error ? 'alert' : undefined}
            style={{
              position: 'absolute', left: 0, right: 0, top: 'calc(50% + 44px)', textAlign: 'center',
              fontSize: 13, lineHeight: 1.5, color: messageColor, opacity: message ? 1 : 0, transition: 'opacity .3s',
            }}
          >
            {message}
          </div>

          {/* canvas dos coraçõezinhos (sai fora do cartão) */}
          <canvas ref={canvasRef} style={{ position: 'absolute', left: '50%', top: '50%', width: 760, height: 760, transform: 'translate(-50%,-50%)', pointerEvents: 'none', zIndex: 5 }} />
        </div>

        <CardFooter phase={phase} theme={theme} onClear={clear} />

        {/* input real (invisível) */}
        <input {...inputProps} />
      </div>
    </div>
  )
}
