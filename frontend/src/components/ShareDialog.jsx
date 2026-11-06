import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Ban, Check, Copy, Globe, Laptop, Link2, LogOut, Power, Share2, ShieldCheck, Smartphone, TimerReset, Trash2, X } from 'lucide-react'
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
  const [devs, setDevs] = useState(null) // { require_approval, devices }
  const now = useNow(1000)

  const refresh = useCallback(async () => {
    try {
      const [i, d] = await Promise.all([api.share(), api.shareDevices()])
      setInfo(i)
      setDevs(d)
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

  async function devAct(fn) {
    try {
      setDevs(await fn())
    } catch (e) {
      toast(e.message, 'error')
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
                  <li key={a.profile} className="rounded-ui-sm border border-line px-3 py-2.5">
                   <div className="flex items-center gap-3">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${a.online ? 'bg-ok' : 'bg-line'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        {a.display_name}
                        {a.is_me && <span className="ml-1.5 text-xs font-normal text-muted">(tu)</span>}
                      </span>
                      <span className="block text-xs text-muted">
                        {a.online
                          ? `Ligado em ${a.devices.length} dispositivo${a.devices.length === 1 ? '' : 's'}`
                          : 'Sem sessão iniciada'}
                      </span>
                    </span>
                   </div>
                   {a.devices.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t border-line pt-2">
                      {a.devices.map((d, i) => {
                        const Icon = /iPhone|Android|iPad/.test(d.agent) ? Smartphone : Laptop
                        return (
                          <li key={i} className="flex items-center gap-2 text-xs">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
                            <span className="min-w-0 flex-1 truncate">
                              {d.agent}
                              {d.current && <span className="ml-1.5 text-muted">(este)</span>}
                            </span>
                            <span className="shrink-0 text-muted">{ago(now / 1000 - d.since)}</span>
                            <span
                              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.7rem] ${
                                d.remote ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted'
                              }`}
                            >
                              {d.remote ? <Globe className="h-3 w-3" /> : <Laptop className="h-3 w-3" />}
                              {d.remote ? 'Link' : 'Local'}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                   )}
                  </li>
                ))}
              </ul>
            </section>

            {/* Dispositivos */}
            {devs && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Dispositivos do link</p>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={devs.require_approval}
                      onChange={(e) => devAct(() => api.setDeviceApproval(e.target.checked))}
                    />
                    Aprovar dispositivos novos
                  </label>
                </div>
                {devs.devices.length === 0 ? (
                  <p className="rounded-ui-sm border border-dashed border-line px-3 py-4 text-center text-xs text-muted">
                    Ainda nenhum dispositivo entrou pelo link.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {devs.devices.map((d) => (
                      <DeviceRow key={d.id} d={d} now={now} act={(a) => devAct(() => api.deviceAction(d.id, a))}
                        forget={() => devAct(() => api.forgetDevice(d.id))} names={info?.accounts} />
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-muted">
                  O dispositivo é reconhecido por um cookie, não pelo IP, por isso uma VPN não o engana. Quem apagar os
                  cookies aparece como dispositivo novo e fica pendente.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function ago(sec) {
  if (sec < 60) return 'agora mesmo'
  if (sec < 3600) return `há ${Math.floor(sec / 60)} min`
  if (sec < 86400) return `há ${Math.floor(sec / 3600)} h`
  return `há ${Math.floor(sec / 86400)} d`
}

const STATUS = {
  pending: { label: 'Por aprovar', cls: 'bg-warn/10 text-warn' },
  approved: { label: 'Aprovado', cls: 'bg-ok/10 text-ok' },
  blocked: { label: 'Bloqueado', cls: 'bg-danger/10 text-danger' },
}

function DeviceRow({ d, now, act, forget, names }) {
  const st = STATUS[d.status] || STATUS.pending
  const who = d.profiles.map((p) => names?.find((a) => a.profile === p)?.display_name || p).join(', ')
  const Icon = /iPhone|Android|iPad/.test(d.agent) ? Smartphone : Laptop
  return (
    <li className="rounded-ui-sm border border-line px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{d.agent}</span>
            {d.online > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-ok" title="Com sessão ativa" />}
          </span>
          <span className="block truncate text-xs text-muted">
            {who} · visto {ago(now / 1000 - d.last_seen)} · {d.last_ip}
            {d.ips.length > 1 && ` (+${d.ips.length - 1} IP${d.ips.length > 2 ? 's' : ''})`}
            {d.failed > 0 && ` · ${d.failed} código${d.failed > 1 ? 's' : ''} errado${d.failed > 1 ? 's' : ''}`}
          </span>
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.7rem] ${st.cls}`}>{st.label}</span>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        {d.status !== 'approved' && (
          <button className="btn-outline px-2.5 py-1 text-xs" onClick={() => act('approve')}>
            <ShieldCheck className="h-3.5 w-3.5" /> Aprovar
          </button>
        )}
        {d.online > 0 && (
          <button className="btn-outline px-2.5 py-1 text-xs" onClick={() => act('disconnect')}>
            <LogOut className="h-3.5 w-3.5" /> Desligar
          </button>
        )}
        {d.status !== 'blocked' && (
          <button className="btn-ghost px-2.5 py-1 text-xs text-danger hover:bg-danger/10" onClick={() => act('block')}>
            <Ban className="h-3.5 w-3.5" /> Bloquear
          </button>
        )}
        <button className="btn-ghost px-2.5 py-1 text-xs text-muted" onClick={forget} title="Esquecer (volta a ser novo)">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  )
}
