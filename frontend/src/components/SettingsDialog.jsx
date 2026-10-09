import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Camera, Check, Database, Download, ImagePlus, LogOut, MessageSquare, Palette, Pipette, RotateCcw, Trash2,
  User, X,
} from 'lucide-react'
import { api, downloadBlob } from '../api'
import { CHAT_BACKGROUNDS, LOGIN_BACKGROUNDS, backgroundLayers, mediaUrl } from '../backgrounds'
import { ACCENTS, APPEARANCE_KEYS, CHAT_KEYS, DEFAULTS, accentContrast, resolveTheme } from '../theme'
import ColorPicker from './ColorPicker'
import Popover from './Popover'
import { useSettings } from './ThemeProvider'
import { Modal, Segmented, Spinner, Switch, formatDuration, useNow, useToast } from './ui'

const TABS = [
  { id: 'appearance', label: 'Aparência', icon: Palette },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'account', label: 'Conta', icon: User },
  { id: 'data', label: 'Dados', icon: Database },
]

export default function SettingsDialog({
  open, onClose, session, activeConversation, conversations = [], media = {}, onMediaChanged, onLogout, onDeletedAll,
}) {
  const { settings, update, save, revert, dirty } = useSettings()
  const toast = useToast()
  const [tab, setTab] = useState('appearance')
  const [saving, setSaving] = useState(false)

  async function persist() {
    if (!dirty) return true
    setSaving(true)
    try {
      await save()
      return true
    } catch (e) {
      toast(`Não foi possível guardar: ${e.message}`, 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  // As alterações guardam-se ao fechar (como pede a blueprint 9.1).
  async function close() {
    if (await persist()) onClose()
  }

  function resetTab() {
    const keys = tab === 'appearance' ? APPEARANCE_KEYS : CHAT_KEYS
    update(Object.fromEntries(keys.map((k) => [k, DEFAULTS[k]])))
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Definições"
      className="flex h-[100dvh] max-w-3xl flex-col rounded-none sm:h-[min(42rem,90vh)] sm:rounded-ui-lg"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="text-lg font-semibold">Definições</h2>
        <button className="icon-btn" onClick={close} aria-label="Fechar definições">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div
          role="tablist"
          aria-label="Separadores das definições"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`focus-ring flex shrink-0 items-center gap-2 rounded-ui-sm px-3 py-2 text-sm transition-colors ${
                tab === id ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg'
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" role="tabpanel">
          {tab === 'appearance' && (
            <AppearanceTab settings={settings} update={update} media={media} onMediaChanged={onMediaChanged} />
          )}
          {tab === 'chat' && <ChatTab settings={settings} update={update} />}
          {tab === 'account' && (
            <AccountTab session={session} media={media} onMediaChanged={onMediaChanged} onLogout={onLogout} />
          )}
          {tab === 'data' && <DataTab conversation={activeConversation} conversations={conversations} onDeletedAll={onDeletedAll} />}
        </div>
      </div>

      {(tab === 'appearance' || tab === 'chat') && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <button className="btn-ghost text-muted" onClick={resetTab}>
            <RotateCcw className="h-4 w-4" /> Repor predefinições
          </button>
          <span className="flex-1" />
          {dirty && (
            <button className="btn-ghost" onClick={revert}>
              Descartar
            </button>
          )}
          <button className="btn-primary" onClick={persist} disabled={!dirty || saving}>
            {saving ? <Spinner /> : 'Guardar'}
          </button>
        </div>
      )}
    </Modal>
  )
}

function Field({ label, description, children }) {
  return (
    <div className="py-3">
      <p className="text-sm font-medium">{label}</p>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}

const THEME_PREVIEW = {
  light: ['#EEF0F3', '#FFFFFF', '#14161C'],
  dark: ['#111113', '#18181B', '#F0F0F2'],
  sepia: ['#F4ECDE', '#FBF6EC', '#3B2F22'],
  high_contrast: ['#000000', '#000000', '#FFFFFF'],
}

function ThemeSwatch({ id, label, active, onClick }) {
  const colors = id === 'system' ? null : THEME_PREVIEW[id]
  return (
    <button
      onClick={onClick}
      role="radio"
      aria-checked={active}
      className={`focus-ring flex flex-col items-center gap-1.5 rounded-ui-sm border-2 p-1.5 text-xs transition-colors ${
        active ? 'border-accent' : 'border-transparent hover:border-line'
      }`}
    >
      <span className="flex h-12 w-16 overflow-hidden rounded-[calc(var(--radius)*0.5)] border border-line">
        {colors ? (
          <span className="flex flex-1 flex-col gap-1 p-1.5" style={{ background: colors[0] }}>
            <span className="h-1.5 w-8 rounded-full" style={{ background: colors[2], opacity: 0.8 }} />
            <span className="flex-1 rounded-sm" style={{ background: colors[1], border: `1px solid ${colors[2]}22` }} />
          </span>
        ) : (
          <>
            <span className="flex-1" style={{ background: THEME_PREVIEW.light[0] }} />
            <span className="flex-1" style={{ background: THEME_PREVIEW.dark[0] }} />
          </>
        )}
      </span>
      {label}
    </button>
  )
}

function AppearanceTab({ settings, update, media, onMediaChanged }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerBtn = useRef(null)
  const custom = !ACCENTS.includes(settings.accent)
  const lowContrast = accentContrast(settings) < (['dark', 'high_contrast'].includes(resolveTheme(settings.theme)) ? 4.5 : 3)

  return (
    <div className="divide-y divide-line">
      <Preview settings={settings} />

      <Field label="Tema">
        <div role="radiogroup" aria-label="Tema" className="flex flex-wrap gap-1">
          {[
            ['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Escuro'], ['sepia', 'Papel'], ['high_contrast', 'Alto contraste'],
          ].map(([id, label]) => (
            <ThemeSwatch key={id} id={id} label={label} active={settings.theme === id} onClick={() => update({ theme: id })} />
          ))}
        </div>
      </Field>

      <Field label="Cor de destaque">
        <div className="flex flex-wrap items-center gap-2">
          {ACCENTS.map((c) => (
            <button
              key={c}
              onClick={() => update({ accent: c })}
              className={`focus-ring h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${
                settings.accent === c ? 'border-fg' : 'border-transparent'
              }`}
              style={{ background: c }}
              aria-label={`Cor ${c}`}
              aria-pressed={settings.accent === c}
            />
          ))}
          <span className="mx-1.5 h-6 w-px bg-line" aria-hidden="true" />
          {/* Cor à escolha: anel de cores à volta; dentro, a cor escolhida ou o conta-gotas. */}
          <button
            ref={pickerBtn}
            onClick={() => setPickerOpen((o) => !o)}
            className={`focus-ring group relative h-9 w-9 rounded-full p-[3px] transition-transform hover:scale-110 ${
              custom || pickerOpen ? 'ring-2 ring-fg ring-offset-2 ring-offset-surface' : ''
            }`}
            style={{ background: 'conic-gradient(from 180deg, #ff5f6d, #ffc371, #f9f871, #7ee8a2, #4facfe, #a18cd1, #fbc2eb, #ff5f6d)' }}
            aria-label="Escolher outra cor"
            aria-expanded={pickerOpen}
            title="Escolher outra cor"
          >
            <span
              className="flex h-full w-full items-center justify-center rounded-full border-2 border-surface"
              style={{ background: custom ? settings.accent : 'rgb(var(--surface))' }}
            >
              {!custom && <Pipette className="h-3.5 w-3.5 text-fg/70 transition-colors group-hover:text-fg" />}
            </span>
          </button>
          <Popover anchorRef={pickerBtn} open={pickerOpen} onClose={() => setPickerOpen(false)}>
            <ColorPicker value={settings.accent} onChange={(accent) => update({ accent })} />
          </Popover>
        </div>
        {lowContrast && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            Esta cor tem pouco contraste com o fundo deste tema, por isso aparece um pouco
            {resolveTheme(settings.theme) === 'dark' || settings.theme === 'high_contrast' ? ' mais clara' : ' mais escura'}.
          </p>
        )}
      </Field>

      <Field label="Tipo de letra">
        <Segmented
          label="Tipo de letra"
          value={settings.font}
          onChange={(font) => update({ font })}
          options={[
            { value: 'sans', label: 'Sistema' },
            { value: 'serif', label: 'Serifada' },
            { value: 'mono', label: 'Monoespaçada' },
          ]}
        />
      </Field>

      <Field label="Tamanho do texto">
        <Segmented
          label="Tamanho do texto"
          value={settings.font_size}
          onChange={(font_size) => update({ font_size })}
          options={['s', 'm', 'l', 'xl'].map((v) => ({ value: v, label: v.toUpperCase() }))}
        />
      </Field>

      <div className="grid gap-x-6 sm:grid-cols-2">
        <Field label="Densidade">
          <Segmented
            label="Densidade"
            value={settings.density}
            onChange={(density) => update({ density })}
            options={[
              { value: 'compact', label: 'Compacta' },
              { value: 'normal', label: 'Normal' },
              { value: 'comfortable', label: 'Confortável' },
            ]}
          />
        </Field>
        <Field label="Cantos">
          <Segmented
            label="Arredondamento dos cantos"
            value={settings.radius}
            onChange={(radius) => update({ radius })}
            options={[
              { value: 'none', label: 'Retos' },
              { value: 'sm', label: 'S' },
              { value: 'md', label: 'M' },
              { value: 'lg', label: 'L' },
              { value: 'xl', label: 'XL' },
            ]}
          />
        </Field>
        <Field label="Largura do chat">
          <Segmented
            label="Largura do chat"
            value={settings.chat_width}
            onChange={(chat_width) => update({ chat_width })}
            options={[
              { value: 'narrow', label: 'Estreita' },
              { value: 'medium', label: 'Média' },
              { value: 'wide', label: 'Larga' },
            ]}
          />
        </Field>
        <Field label="Mensagens">
          <Segmented
            label="Estilo das mensagens"
            value={settings.message_style}
            onChange={(message_style) => update({ message_style })}
            options={[
              { value: 'modern', label: 'Moderno' },
              { value: 'bubbles', label: 'Com bolhas' },
              { value: 'clean', label: 'Limpo' },
            ]}
          />
        </Field>
        <Field label="Fundo das conversas">
          <BackgroundPicker
            options={CHAT_BACKGROUNDS}
            value={settings.background}
            onChange={(background) => update({ background })}
            kind="chat_bg"
            media={media}
            onMediaChanged={onMediaChanged}
          />
        </Field>
        <Field label="Fundo do ecrã de entrada" description="Aparece neste dispositivo quando entras com este perfil.">
          <BackgroundPicker
            options={LOGIN_BACKGROUNDS}
            value={settings.login_background}
            onChange={(login_background) => update({ login_background })}
            kind="login_bg"
            media={media}
            onMediaChanged={onMediaChanged}
          />
        </Field>
      </div>
    </div>
  )
}

/**
 * Foto de perfil: ao escolher um ficheiro mostra-se primeiro a pré-visualização (já recortada ao
 * quadrado, como fica guardada) e só muda com "Guardar".
 */
function AvatarEditor({ session, media, onMediaChanged }) {
  const toast = useToast()
  const input = useRef(null)
  const [pending, setPending] = useState(null) // { file, url }
  const [busy, setBusy] = useState(false)
  const current = mediaUrl('avatar', media?.avatar)
  const shown = pending?.url || current
  const initials = (session.display_name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('')

  useEffect(() => () => pending && URL.revokeObjectURL(pending.url), [pending])

  async function run(fn) {
    setBusy(true)
    try {
      onMediaChanged?.(await fn())
      setPending(null)
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-4 rounded-ui border border-line p-3">
      <div className="relative shrink-0">
        {shown ? (
          <img src={shown} alt="" className="h-20 w-20 rounded-ui object-cover" />
        ) : (
          <span className="flex h-20 w-20 items-center justify-center rounded-ui bg-accent text-2xl font-semibold text-accent-fg">
            {initials}
          </span>
        )}
        {pending && (
          <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-fg px-2 py-0.5 text-[0.65rem] font-semibold text-bg">
            Pré-visualização
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{session.display_name}</p>
        <p className="text-xs text-muted">
          {pending ? 'Gostas? Guarda para aplicar.' : 'PNG, JPEG ou WEBP · recortada ao quadrado'}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {pending ? (
            <>
              <button className="btn-primary px-3 py-1.5" disabled={busy} onClick={() => run(() => api.uploadMedia('avatar', pending.file))}>
                {busy ? <Spinner /> : <Check className="h-4 w-4" />} Guardar
              </button>
              <button className="btn-ghost px-3 py-1.5" disabled={busy} onClick={() => setPending(null)}>
                Cancelar
              </button>
            </>
          ) : (
            <>
              <button className="btn-outline px-3 py-1.5" onClick={() => input.current?.click()} disabled={busy}>
                <Camera className="h-4 w-4" /> {current ? 'Alterar' : 'Adicionar foto'}
              </button>
              {current && (
                <button
                  className="btn-ghost px-3 py-1.5 text-muted hover:text-danger"
                  onClick={() => run(() => api.deleteMedia('avatar'))}
                  disabled={busy}
                >
                  <Trash2 className="h-4 w-4" /> Remover
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) setPending({ file: f, url: URL.createObjectURL(f) })
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** Escolher um fundo: amostras de cada desenho e, em "Imagem", carregar/trocar/remover a foto. */
function BackgroundPicker({ options, value, onChange, kind, media, onMediaChanged }) {
  const toast = useToast()
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  const image = mediaUrl(kind, media?.[kind])

  async function upload(file) {
    if (!file) return
    setBusy(true)
    try {
      onMediaChanged?.(await api.uploadMedia(kind, file))
      onChange('image')
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    try {
      onMediaChanged?.(await api.deleteMedia(kind))
      if (value === 'image') onChange(options[0].id)
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  return (
    <div className="space-y-2.5">
      <div role="radiogroup" className="flex flex-wrap gap-2">
        {options.map((o) => {
          const layers =
            o.id === 'image'
              ? image && `url("${image}") center / cover no-repeat`
              : backgroundLayers(o.id, { accent: 'var(--accent)', ink: 'var(--text)', bg: 'var(--bg)' })
          return (
            <button
              key={o.id}
              role="radio"
              aria-checked={value === o.id}
              onClick={() => (o.id === 'image' && !image ? input.current?.click() : onChange(o.id))}
              className={`focus-ring flex flex-col items-center gap-1.5 rounded-ui-sm border-2 p-1.5 text-xs transition-colors ${
                value === o.id ? 'border-accent' : 'border-transparent hover:border-line'
              }`}
            >
              <span
                className="flex h-12 w-16 items-center justify-center overflow-hidden rounded-[calc(var(--radius)*0.5)] border border-line text-muted"
                style={{ background: layers ? `${layers.replace(/\d+vw/g, '40px').replace(/\d+vh/g, '30px')}, rgb(var(--bg))` : 'rgb(var(--bg))' }}
              >
                {o.id === 'image' && !image && (busy ? <Spinner /> : <ImagePlus className="h-4 w-4" />)}
              </span>
              {o.label}
            </button>
          )
        })}
      </div>
      {image && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-outline px-2.5 py-1.5 text-xs" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <ImagePlus className="h-3.5 w-3.5" />} Trocar imagem
          </button>
          <button className="btn-ghost px-2.5 py-1.5 text-xs text-danger hover:bg-danger/10" onClick={remove}>
            <Trash2 className="h-3.5 w-3.5" /> Remover imagem
          </button>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          upload(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** Amostra do chat com as definições atuais (a app atrás da janela também muda em direto). */
function Preview({ settings }) {
  const style = settings.message_style
  return (
    <div className="pb-4">
      <div className="space-y-2 rounded-ui border border-line bg-bg p-3 text-sm" aria-hidden="true">
        {style === 'modern' ? (
          <>
            <p className="text-base font-semibold tracking-tight">O que é uma Activity?</p>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-muted">
              <img src="/logo-badge.png" alt="" className="h-4 w-4 rounded" />
              Dire
            </p>
            <p className="text-fg/90">
              Representa um único ecrã com interface.{' '}
              <span className="rounded-full bg-accent/10 px-1.5 text-[0.78em] font-medium text-accent">slides.pdf, Pág. 34</span>
            </p>
          </>
        ) : style === 'clean' ? (
          <>
            <p className="font-medium">O que é uma Activity?</p>
            <p className="text-fg/90">
              Representa um único ecrã com interface.{' '}
              <span className="rounded-full bg-accent/10 px-1.5 text-[0.78em] font-medium text-accent">slides.pdf, Pág. 34</span>
            </p>
          </>
        ) : (
          <>
            <div className="flex justify-end">
              <span className="pad-d rounded-ui-lg rounded-br-ui-sm bg-accent text-accent-fg">O que é uma Activity?</span>
            </div>
            <div className="card pad-d rounded-bl-ui-sm">
              Representa um único ecrã com interface.{' '}
              <span className="rounded-full bg-accent/10 px-1.5 text-[0.78em] font-medium text-accent">slides.pdf, Pág. 34</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ChatTab({ settings, update }) {
  return (
    <div className="divide-y divide-line">
      <Field label="Enviar a pergunta com">
        <Segmented
          label="Enviar com"
          value={settings.send_with}
          onChange={(send_with) => update({ send_with })}
          options={[
            { value: 'enter', label: 'Enter' },
            { value: 'ctrl_enter', label: 'Ctrl + Enter' },
          ]}
        />
      </Field>
      <div className="py-1">
        <Switch
          label="Fontes abertas por omissão"
          description="Mostra logo a lista de páginas e slides usados em cada resposta."
          checked={settings.sources_open}
          onChange={(sources_open) => update({ sources_open })}
        />
        <Switch
          label="Mostrar tokens por resposta"
          description="Quantos tokens o modelo leu e escreveu (útil para os limites do link)."
          checked={settings.show_tokens}
          onChange={(show_tokens) => update({ show_tokens })}
        />
        <Switch
          label="Pedir confirmação antes de apagar"
          description="Conversas e documentos."
          checked={settings.confirm_delete}
          onChange={(confirm_delete) => update({ confirm_delete })}
        />
      </div>
    </div>
  )
}

function AccountTab({ session, media, onMediaChanged, onLogout }) {
  const now = useNow(30000)
  const left = session.expires_at - now / 1000
  return (
    <div className="divide-y divide-line">
      <Field label="Foto de perfil">
        <AvatarEditor session={session} media={media} onMediaChanged={onMediaChanged} />
      </Field>
      <Field label="Nome" description="Definido no ficheiro de perfis do servidor.">
        <p className="text-base">{session.display_name}</p>
      </Field>
      <Field label="Sessão">
        <p className="text-sm text-muted">
          {session.remote ? 'Acesso por link partilhado' : 'Acesso local'} · termina em {formatDuration(left)}
        </p>
      </Field>
      <div className="py-4">
        <button className="btn-outline" onClick={onLogout}>
          <LogOut className="h-4 w-4" /> Sair
        </button>
      </div>
    </div>
  )
}

const CONFIRM_WORD = 'APAGAR'

function DataTab({ conversation, conversations, onDeletedAll }) {
  const toast = useToast()
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  // Por omissão, a conversa aberta (se tiver mensagens) ou a mais recente com mensagens.
  const withMessages = conversations.filter((c) => c.n_messages !== 0)
  const [chosen, setChosen] = useState(
    () => (conversation && conversation.n_messages !== 0 ? conversation.id : withMessages[0]?.id) || '',
  )
  const target = conversations.find((c) => c.id === chosen)

  // Partes da conversa: cada pergunta com a resposta que se lhe seguiu. Todas marcadas ao abrir.
  const [parts, setParts] = useState(null) // [{ id, question, answer }]
  const [picked, setPicked] = useState(() => new Set())
  useEffect(() => {
    setParts(null)
    if (!chosen) return
    let alive = true
    api
      .messages(chosen)
      .then((msgs) => {
        if (!alive) return
        const out = []
        for (const m of msgs) {
          if (m.role === 'user') out.push({ id: m.id, question: m.content, answer: '' })
          else if (out.length && !out.at(-1).answer) out.at(-1).answer = m.content
        }
        setParts(out)
        setPicked(new Set(out.map((p) => p.id)))
      })
      .catch((e) => alive && toast(e.message, 'error'))
    return () => {
      alive = false
    }
  }, [chosen, toast])

  const togglePart = (id) =>
    setPicked((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const allPicked = parts && picked.size === parts.length

  async function exportConv() {
    if (!target || !picked.size) return
    setExporting(true)
    try {
      const blob = await api.exportConversation(target.id, allPicked ? null : [...picked])
      if (blob.type !== 'application/pdf') throw new Error('Servidor indisponível. Tenta novamente daqui a pouco.')
      const safe = target.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'conversa'
      downloadBlob(blob, `${safe}.pdf`)
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setExporting(false)
    }
  }

  async function deleteAll() {
    setBusy(true)
    try {
      const r = await api.deleteAllConversations()
      toast(`${r.deleted?.length ?? r.deleted ?? 0} conversas apagadas.`, 'success')
      setWord('')
      onDeletedAll()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="divide-y divide-line">
      <Field label="Exportar conversa" description="Perguntas, respostas e fontes num PDF.">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            className="input w-auto min-w-0 max-w-full flex-1 py-2 text-sm sm:max-w-sm"
            aria-label="Conversa a exportar"
          >
            {conversations.length === 0 && <option value="">Ainda não tens conversas</option>}
            {conversations.map((c) => (
              <option key={c.id} value={c.id} disabled={c.n_messages === 0}>
                {c.title.length > 60 ? `${c.title.slice(0, 59)}…` : c.title}
                {c.n_messages === 0 ? ' (sem mensagens)' : ''}
              </option>
            ))}
          </select>
          <button className="btn-primary" onClick={exportConv} disabled={!target || exporting || !picked.size}>
            {exporting ? <Spinner /> : <Download className="h-4 w-4" />} Exportar PDF
          </button>
        </div>
        {target && (
          <div className="mt-3 rounded-ui border border-line">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-muted">
              <span className="flex-1">
                {parts ? `${picked.size} de ${parts.length} ${parts.length === 1 ? 'pergunta' : 'perguntas'} (cada uma com a resposta)` : 'A carregar…'}
              </span>
              {parts?.length > 0 && (
                <button
                  className="focus-ring rounded-sm font-medium text-accent hover:underline"
                  onClick={() => setPicked(allPicked ? new Set() : new Set(parts.map((p) => p.id)))}
                >
                  {allPicked ? 'Desmarcar todas' : 'Marcar todas'}
                </button>
              )}
            </div>
            <ul className="max-h-56 overflow-y-auto p-1">
              {!parts && (
                <li className="flex justify-center py-4 text-muted"><Spinner /></li>
              )}
              {parts?.map((p, i) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-ui-sm px-2 py-2 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                      checked={picked.has(p.id)}
                      onChange={() => togglePart(p.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        <span className="mr-1.5 text-muted">{i + 1}.</span>
                        {p.question.split('\n')[0]}
                      </span>
                      {p.answer && <span className="block truncate text-xs text-muted">{p.answer.replace(/\s+/g, ' ')}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Field>
      <div className="py-4">
        <div className="rounded-ui border border-danger/40 bg-danger/5 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger">
            <AlertTriangle className="h-4 w-4" /> Apagar todas as conversas
          </p>
          <p className="mt-1 text-xs text-muted">
            Apaga todas as conversas deste perfil, incluindo as fixadas, com os documentos e o histórico. Não dá para
            desfazer.
          </p>
          <label className="mt-3 block text-xs text-muted" htmlFor="confirm-word">
            Escreve <span className="font-mono font-semibold text-fg">{CONFIRM_WORD}</span> para confirmar
          </label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <input
              id="confirm-word"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              className="input w-40 py-1.5 font-mono"
              autoComplete="off"
            />
            <button className="btn-danger" disabled={word !== CONFIRM_WORD || busy} onClick={deleteAll}>
              {busy ? <Spinner /> : <Trash2 className="h-4 w-4" />} Apagar tudo
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
