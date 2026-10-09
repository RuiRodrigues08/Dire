import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, Globe, Laptop, Link2, Power, Share2, TimerReset, X } from 'lucide-react'
import { api } from '../api'
import { Modal, Spinner, formatDuration, useNow, useToast } from './ui'

/*
  Partilha por link (Quick Tunnel do Cloudflare): ativar com duração e limites opcionais,
  copiar o link, estender ou parar. Mostra também que contas estão ligadas agora,
  neste computador e/ou pelo link. Só existe para sessões locais.
*/

const DURATIONS = [
  { id: 30, label: '30 min' },
  { id: 60, label: '1 h' },
  { id: 120, label: '2 h' },
  { id: 240, label: '4 h' },
  { id: 'until', label: 'Até…' },
  { id: 'open', label: 'Até parar' },
]

// Valor para <input type="datetime-local"> (hora local, sem segundos).
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
const MAX_MINUTES = 31 * 24 * 60

export default function ShareDialog({ open, onClose }) {
  const toast = useToast()
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [duration, setDuration] = useState(120) // minutos, 'until' (data à escolha) ou 'open' (até parar)
  const [until, setUntil] = useState(() => localInput(new Date(Date.now() + 24 * 3600 * 1000)))
  const [maxQuestions, setMaxQuestions] = useState('')
  const [copied, setCopied] = useState(false)
  const now = useNow(1000)

  const refresh = useCallback(async () => {
    try {
      setInfo(await api.share())
    } catch (e) {
      toast(e.message, 'error')
    }
  }, [toast])

  // Enquanto está aberta, atualiza quem está ligado e o consumo do link.
  useEffect(() => {
    if (!open) return
    refresh()
    const id = setInterval(refresh, 10000)
    return () => clearInterval(id)
  }, [open, refresh])


  async function act(fn) {
    setBusy(true)
    try {
      setInfo(await fn())
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const untilMinutes = Math.round((new Date(until).getTime() - Date.now()) / 60000)
  const badUntil = duration === 'until' && !(untilMinutes >= 5 && untilMinutes <= MAX_MINUTES)
  const minutes = duration === 'open' ? null : duration === 'until' ? untilMinutes : duration

  const start = () =>
    act(() => api.startShare({ minutes, max_questions: maxQuestions ? Number(maxQuestions) : null }))

  async function copy() {
    await navigator.clipboard?.writeText(info.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const left = info?.expires_at ? info.expires_at - now / 1000 : null
  const others = info?.accounts?.filter((a) => !a.is_me) || []
  const me = info?.accounts?.find((a) => a.is_me)

  return (
    <Modal open={open} onClose={onClose} title="Partilhar" className="max-w-lg rounded-b-none sm:rounded-ui-lg">
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-ui-sm bg-accent/10 text-accent">
          <Share2 className="h-[1.1rem] w-[1.1rem]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold leading-tight">Partilhar por link</h2>
          <p className="text-xs text-muted">Dá acesso à app fora deste computador, por tempo limitado.</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
        {!info ? (
          <div className="flex justify-center py-8 text-muted"><Spinner className="h-5 w-5" /></div>
        ) : (
          <>
            {/* Link */}
            {info.active ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-ok">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok/60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ok" />
                  </span>
                  Partilha ativa · {left == null ? 'até a parares' : `termina em ${formatDuration(left)}`}
                </div>
                <div className="flex items-center gap-2 rounded-ui-sm border border-line bg-surface-2 p-1.5 pl-3">
                  <Link2 className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{info.url}</span>
                  <button className="btn-primary px-3 py-1.5 text-sm" onClick={copy}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
                <p className="text-xs text-muted">
                  Quem abrir o link entra com o código da sua conta.
                  {info.max_questions != null && ` Perguntas: ${info.questions_used} de ${info.max_questions}.`}
                  {info.max_tokens != null && ` Tokens: ${info.tokens_used} de ${info.max_tokens}.`}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-outline" disabled={busy} onClick={() => act(() => api.extendShare(30))}>
                    <TimerReset className="h-4 w-4" /> Mais 30 min
                  </button>
                  <button className="btn-ghost text-danger hover:bg-danger/10" disabled={busy} onClick={() => act(api.stopShare)}>
                    <Power className="h-4 w-4" /> Parar partilha
                  </button>
                </div>
              </section>
            ) : (
              <section className="space-y-3">
                {!info.available && (
                  <p className="flex items-start gap-2 rounded-ui-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                    <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                    O cloudflared não está instalado neste computador. Instala-o para poderes criar o link.
                  </p>
                )}
                <div>
                  <p className="mb-1.5 text-sm font-medium">Duração</p>
                  <div className="inline-flex flex-wrap gap-1 rounded-ui-sm bg-surface-2 p-1" role="radiogroup" aria-label="Duração">
                    {DURATIONS.map((d) => (
                      <button
                        key={d.id}
                        role="radio"
                        aria-checked={duration === d.id}
                        onClick={() => setDuration(d.id)}
                        className={`focus-ring rounded-[calc(var(--radius)*0.45)] px-3 py-1.5 text-sm transition-colors ${
                          duration === d.id ? 'bg-surface font-medium shadow-sm' : 'text-muted hover:text-fg'
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                  {duration === 'until' && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        type="datetime-local"
                        value={until}
                        min={localInput(new Date(Date.now() + 5 * 60000))}
                        onChange={(e) => setUntil(e.target.value)}
                        className="input w-auto py-1.5"
                        aria-label="Partilhar até"
                      />
                      <span className={`text-xs ${badUntil ? 'text-danger' : 'text-muted'}`}>
                        {badUntil ? 'Escolhe entre 5 minutos e 31 dias a partir de agora.' : `durante ${formatDuration(untilMinutes * 60)}`}
                      </span>
                    </div>
                  )}
                  {duration === 'open' && (
                    <p className="mt-2 text-xs text-muted">O link fica ativo até carregares em “Parar partilha” (ou fechares a app).</p>
                  )}
                </div>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">Limite de perguntas (opcional)</span>
                  <input
                    type="number"
                    min={1}
                    value={maxQuestions}
                    onChange={(e) => setMaxQuestions(e.target.value.replace(/\D/g, ''))}
                    placeholder="Sem limite"
                    className="input w-40 py-1.5"
                  />
                </label>
                <button className="btn-primary" disabled={busy || !info.available || badUntil} onClick={start}>
                  {busy ? <Spinner /> : <Globe className="h-4 w-4" />}
                  {busy ? 'A criar o link…' : 'Criar link'}
                </button>
              </section>
            )}

            {/* Contas */}
            <section>
              <p className="mb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Contas</p>
              <ul className="space-y-1">
                {[...(me ? [me] : []), ...others].map((a) => (
                  <li key={a.profile} className="flex items-center gap-3 rounded-ui-sm border border-line px-3 py-2.5">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${a.online ? 'bg-ok' : 'bg-line'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        {a.display_name}
                        {a.is_me && <span className="ml-1.5 text-xs font-normal text-muted">(tu)</span>}
                      </span>
                      <span className="block text-xs text-muted">
                        {a.online ? 'Com sessão iniciada' : 'Sem sessão iniciada'}
                      </span>
                    </span>
                    {a.local > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[0.7rem] text-muted" title="Sessões neste computador">
                        <Laptop className="h-3 w-3" /> {a.local}
                      </span>
                    )}
                    {a.remote > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[0.7rem] text-accent" title="Sessões pelo link">
                        <Globe className="h-3 w-3" /> {a.remote}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </Modal>
  )
}
