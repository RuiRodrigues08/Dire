import { useEffect, useRef, useState } from 'react'

/*
  Seletor de cor: arrastar na área escolhe saturação e brilho, a barra de baixo escolhe a
  tonalidade. Cada movimento chama `onChange(#RRGGBB)`, por isso a app muda em direto.
*/

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))

function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max }
}

function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/** Arrastar com o rato, o dedo ou a caneta; devolve a posição relativa (0–1) no elemento. */
function useDrag(onMove) {
  const ref = useRef(null)
  const move = useRef(onMove)
  move.current = onMove
  const handlers = {
    onPointerDown: (e) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      emit(e)
    },
    onPointerMove: (e) => e.currentTarget.hasPointerCapture(e.pointerId) && emit(e),
  }
  function emit(e) {
    const r = ref.current.getBoundingClientRect()
    move.current(clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height))
  }
  return [ref, handlers]
}

export default function ColorPicker({ value, onChange }) {
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [hex, setHex] = useState(value)
  const last = useRef(value)

  // Mudanças de fora (ex.: clicar numa das cores prontas) atualizam o seletor.
  useEffect(() => {
    if (value.toUpperCase() !== last.current.toUpperCase()) {
      setHsv(hexToHsv(value))
      last.current = value
    }
    setHex(value)
  }, [value])

  function set(next) {
    setHsv(next)
    const h = hsvToHex(next)
    last.current = h
    setHex(h)
    onChange(h)
  }

  const [area, areaHandlers] = useDrag((x, y) => set({ ...hsv, s: x, v: 1 - y }))
  const [hue, hueHandlers] = useDrag((x) => set({ ...hsv, h: x * 359.9 }))

  const nudge = (key, step, max = 1) => (e) => {
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key]
    if (d == null) return
    e.preventDefault()
    set({ ...hsv, [key]: clamp(hsv[key] + d, 0, max) })
  }

  return (
    <div className="w-64 space-y-3">
      <div
        ref={area}
        {...areaHandlers}
        role="slider"
        tabIndex={0}
        aria-label="Saturação e brilho"
        aria-valuetext={`saturação ${Math.round(hsv.s * 100)}%, brilho ${Math.round(hsv.v * 100)}%`}
        onKeyDown={(e) => (e.shiftKey ? nudge('v', 0.02)(e) : nudge('s', 0.02)(e))}
        className="focus-ring relative h-40 cursor-crosshair touch-none overflow-hidden rounded-ui-sm"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
        }}
      >
        <span
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.35),0_2px_6px_rgba(0,0,0,.35)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }}
        />
      </div>

      <div
        ref={hue}
        {...hueHandlers}
        role="slider"
        tabIndex={0}
        aria-label="Tonalidade"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        onKeyDown={nudge('h', 4, 359.9)}
        className="focus-ring relative h-3.5 cursor-pointer touch-none rounded-full"
        style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
      >
        <span
          className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.35),0_2px_6px_rgba(0,0,0,.35)]"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="h-8 w-8 shrink-0 rounded-full border border-line" style={{ background: hsvToHex(hsv) }} />
        <input
          value={hex}
          onChange={(e) => {
            const v = e.target.value.trim()
            setHex(v)
            if (/^#[0-9a-fA-F]{6}$/.test(v)) {
              setHsv(hexToHsv(v))
              last.current = v.toUpperCase()
              onChange(v.toUpperCase())
            }
          }}
          maxLength={7}
          className="input flex-1 py-1.5 font-mono text-sm uppercase"
          aria-label="Cor em hexadecimal"
        />
      </div>
    </div>
  )
}
