import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'

// ---------- Avisos (toasts) ----------

const ToastContext = createContext(() => {})

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(1)

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (message, kind = 'info', ms = 5000) => {
      const id = nextId.current++
      setToasts((t) => [...t.slice(-3), { id, message, kind }])
      if (ms) setTimeout(() => dismiss(id), ms)
    },
    [dismiss],
  )

  const icons = { info: Info, error: AlertTriangle, success: CheckCircle2 }
  const tones = { info: 'text-accent', error: 'text-danger', success: 'text-ok' }
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const Icon = icons[t.kind] || Info
          return (
            <div
              key={t.id}
              role={t.kind === 'error' ? 'alert' : 'status'}
              className="card animate-in pointer-events-auto flex w-full max-w-md items-start gap-3 px-4 py-3 text-sm shadow-lg"
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tones[t.kind]}`} />
              <p className="flex-1">{t.message}</p>
              <button className="icon-btn -my-1 -mr-2 h-7 w-7" onClick={() => dismiss(t.id)} aria-label="Fechar aviso">
                <X className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

// ---------- Janela modal ----------

export function Modal({ open, onClose, title, children, className = '', labelledBy }) {
  const panel = useRef(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    setTimeout(() => panel.current?.querySelector('[data-autofocus], input, button')?.focus(), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        className={`card animate-in relative w-full shadow-2xl ${className}`}
      >
        {children}
      </div>
    </div>
  )
}

// ---------- Confirmação (substitui window.confirm) ----------

const ConfirmContext = createContext(async () => true)

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const confirm = useCallback(
    (opts) => new Promise((resolve) => setState({ ...opts, resolve })),
    [],
  )
  const close = (value) => {
    state?.resolve(value)
    setState(null)
  }
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={!!state} onClose={() => close(false)} title={state?.title} className="max-w-sm rounded-b-none sm:rounded-ui-lg">
        {state && (
          <div className="p-5">
            <h2 className="text-base font-semibold">{state.title}</h2>
            {state.message && <p className="mt-2 text-sm text-muted">{state.message}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => close(false)}>
                Cancelar
              </button>
              <button
                className={state.danger ? 'btn-danger' : 'btn-primary'}
                onClick={() => close(true)}
                data-autofocus
              >
                {state.confirmLabel || 'Confirmar'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  )
}

export const useConfirm = () => useContext(ConfirmContext)

// ---------- Pequenos componentes ----------

export function Spinner({ className = 'h-4 w-4' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/** Grupo de botões de escolha única (ex.: S / M / L / XL). */
export function Segmented({ value, onChange, options, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-ui-sm bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`focus-ring rounded-[calc(var(--radius)*0.45)] px-3 py-1.5 text-sm transition-colors ${
            value === o.value ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted hover:text-fg'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, label, description }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`focus-ring relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-line'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  )
}

export function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'agora'
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`
  if (diff < 86400 * 7) return `há ${Math.floor(diff / 86400)} d`
  return d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short' })
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  if (s >= 86400) {
    const d = Math.floor(s / 86400)
    const hd = Math.floor((s % 86400) / 3600)
    return hd ? `${d} d ${hd} h` : `${d} d`
  }
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`
  if (m) return `${m} min`
  return `${s} s`
}

/** Força um novo render a cada `ms` (para contagens decrescentes). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
