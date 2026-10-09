import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/*
  Mini-popup preso a um elemento (`anchorRef`), desenhado por cima de tudo (portal no <body>),
  por isso nunca fica cortado por janelas com scroll. Abre por baixo, ou por cima se não couber.
  Fecha ao clicar fora ou com Esc (sem fechar a janela que está por trás).
*/
export default function Popover({ anchorRef, open, onClose, children, className = '' }) {
  const box = useRef(null)
  const [pos, setPos] = useState(null)

  const place = useCallback(() => {
    const a = anchorRef.current?.getBoundingClientRect()
    const el = box.current
    if (!a || !el) return
    const { width, height } = el.getBoundingClientRect()
    const gap = 8
    let top = a.bottom + gap
    if (top + height > window.innerHeight - gap && a.top - gap - height > gap) top = a.top - gap - height
    const left = Math.min(Math.max(gap, a.left + a.width / 2 - width / 2), window.innerWidth - width - gap)
    setPos({ top, left })
  }, [anchorRef])

  useLayoutEffect(() => {
    if (open) place()
    else setPos(null)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (box.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return
      onClose()
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, onClose, place, anchorRef])

  if (!open) return null
  return createPortal(
    <div
      ref={box}
      role="dialog"
      className={`card animate-in fixed z-[70] p-3 shadow-2xl ${className}`}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
    >
      {children}
    </div>,
    document.body,
  )
}
