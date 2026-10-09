import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Check, ChevronLeft, ChevronRight, CopyCheck, Database, Eye, EyeOff, FileText, Files, LayoutTemplate, Plus, Presentation, Scale,
  Search, Settings2, Trash2, Unlink, UploadCloud, X,
} from 'lucide-react'
import { api } from '../api'
import { useSettings } from './ThemeProvider'
import { Spinner, useConfirm, useToast } from './ui'

/*
  Documentos da conversa: vivem num painel de vidro próprio (DocumentPanel), aberto pelo
  botão de documentos do campo de escrita ou do cabeçalho; entram pela zona de
  carregamento do painel ou arrastando ficheiros para qualquer sítio do chat.
  `excluded` = ids que o utilizador desligou; as perguntas usam só os restantes.
*/

export const ACCEPT = '.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** Carregamentos e remoções. Os carregamentos guardam a conversa de onde saíram. */
export function useDocumentActions({ conversationId, onChanged, setExcluded }) {
  const { settings } = useSettings()
  const confirm = useConfirm()
  const toast = useToast()
  const [uploads, setUploads] = useState([]) // {key, cid, name, status: 'queued'|'indexing'|'ok'|'warning'|'duplicate'|'error', message, warnings}

  const dismiss = useCallback((key) => setUploads((u) => u.filter((x) => x.key !== key)), [])

  // Os que correram bem saem sozinhos; avisos e erros ficam até se fecharem.
  useEffect(() => {
    const done = uploads.filter((u) => u.status === 'ok')
    if (!done.length) return
    const t = setTimeout(() => setUploads((u) => u.filter((x) => x.status !== 'ok')), 2500)
    return () => clearTimeout(t)
  }, [uploads])

  const addFiles = useCallback(
    async (fileList, cidOverride) => {
      const files = [...(fileList || [])].filter(Boolean)
      const cid = cidOverride || conversationId
      if (!files.length || !cid) return
      const items = files.map((f, i) => ({ key: `${Date.now()}-${i}`, cid, name: f.name, status: 'queued' }))
      setUploads((u) => [...u, ...items])
      // Um de cada vez: a indexação usa o CPU todo (embeddings) e o limite de ficheiros é por conversa.
      for (let i = 0; i < files.length; i++) {
        const key = items[i].key
        const set = (patch) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)))
        set({ status: 'indexing' })
        try {
          const r = await api.uploadDocument(cid, files[i])
          if (r.duplicate) {
            set({ status: 'duplicate', message: 'Já existe nesta conversa; não foi indexado de novo.' })
          } else {
            set({
              status: r.warnings?.length ? 'warning' : 'ok',
              message: `${r.n_chunks} blocos indexados`,
              warnings: r.warnings,
            })
          }
          onChanged(cid)
        } catch (e) {
          set({ status: 'error', message: e.message })
        }
      }
    },
    [conversationId, onChanged],
  )

  const remove = useCallback(
    async (doc) => {
      if (settings.confirm_delete) {
        const ok = await confirm({
          title: 'Remover documento?',
          message: `“${doc.filename}” deixa de poder ser usado nas respostas desta conversa.`,
          confirmLabel: 'Remover',
          danger: true,
        })
        if (!ok) return
      }
      try {
        await api.deleteDocument(conversationId, doc.id)
        setExcluded((s) => {
          const n = new Set(s)
          n.delete(doc.id)
          return n
        })
        onChanged(conversationId)
      } catch (e) {
        toast(e.message, 'error')
      }
    },
    [conversationId, settings.confirm_delete, confirm, toast, onChanged, setExcluded],
  )

  const toggle = useCallback(
    (id) =>
      setExcluded((s) => {
        const n = new Set(s)
        n.has(id) ? n.delete(id) : n.add(id)
        return n
      }),
    [setExcluded],
  )

  const mine = uploads.filter((u) => u.cid === conversationId)
  const busy = mine.some((u) => u.status === 'queued' || u.status === 'indexing')
  return { uploads: mine, busy, addFiles, remove, toggle, dismiss }
}

/** Arrastar ficheiros para cima de `ref` (conta entradas/saídas por causa dos filhos). */
export function useFileDrop(onFiles, enabled = true) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')

  const handlers = enabled
    ? {
        onDragEnter: (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          depth.current += 1
          setOver(true)
        },
        onDragOver: (e) => hasFiles(e) && e.preventDefault(),
        onDragLeave: (e) => {
          if (!hasFiles(e)) return
          depth.current = Math.max(0, depth.current - 1)
          if (!depth.current) setOver(false)
        },
        onDrop: (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          depth.current = 0
          setOver(false)
          onFiles(e.dataTransfer.files)
        },
      }
    : {}
  return { over, handlers }
}

export function FilePicker({ inputRef, onFiles }) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      multiple
      hidden
      onChange={(e) => {
        onFiles(e.target.files)
        e.target.value = ''
      }}
    />
  )
}

/** Véu sobre o chat enquanto se arrasta um ficheiro. */
export function DropOverlay({ show }) {
  if (!show) return null
  return (
    <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-ui-lg border border-dashed border-muted/60 bg-bg/95 animate-in">
      <div className="flex flex-col items-center gap-2 text-center">
        <UploadCloud className="h-7 w-7 text-muted" strokeWidth={1.5} />
        <p className="font-medium">Larga para carregar</p>
        <p className="text-sm text-muted">PDF ou PPTX · até 50 MB cada</p>
      </div>
    </div>
  )
}

/** Painel lateral de vidro com os documentos da conversa: carregar, ligar/desligar e remover. */
export function DocumentPanel({
  open, onClose, documents, excluded, uploads, busy, loading, onPick, onToggle, onRemove, onDismiss,
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const togglable = documents.length > 1
  const used = documents.filter((d) => !excluded.has(d.id)).length

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/40 xl:hidden" onClick={onClose} aria-hidden="true" />
      {/* Sobrepõe-se ao chat em vez de o empurrar: a conversa fica sempre centrada. */}
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-80 max-w-[90vw] flex-col shadow-2xl xl:absolute xl:shadow-xl"
        aria-label="Documentos da conversa"
      >
        <div className="animate-in flex h-full flex-col overflow-hidden border-l border-line bg-surface">
          <div className="flex items-center gap-3 h-[4.5rem] border-b border-line px-4 mb-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold leading-tight">Documentos</h2>
              <p className="text-xs text-muted">
                {documents.length === 0
                  ? 'Nenhum carregado'
                  : `${used === documents.length ? documents.length : `${used} de ${documents.length}`} em uso`}
              </p>
            </div>
            <button className="icon-btn rounded-full" onClick={onClose} aria-label="Fechar documentos" title="Fechar">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="px-3">
            <button
              onClick={onPick}
              className="focus-ring group flex w-full items-center gap-3 rounded-ui border border-dashed border-line px-4 py-3.5 text-left transition-colors hover:border-muted/60 hover:bg-surface-2"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center text-muted">
                {busy ? <Spinner className="h-5 w-5" /> : <UploadCloud className="h-5 w-5" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{busy ? 'A preparar os documentos…' : 'Carregar documentos'}</span>
                <span className="block text-xs text-muted">PDF ou PPTX · até 50 MB cada</span>
              </span>
            </button>
          </div>

          <div className="mt-3 flex-1 overflow-y-auto px-3 pb-3">
            {uploads.length > 0 && (
              <ul className="mb-3 space-y-1.5" aria-label="Carregamentos">
                {uploads.map((u) => (
                  <UploadRow key={u.key} u={u} onDismiss={() => onDismiss(u.key)} />
                ))}
              </ul>
            )}

            {loading && documents.length === 0 && (
              <div className="space-y-2" aria-hidden="true">
                {[1, 2].map((k) => (
                  <div key={k} className="h-12 animate-pulse rounded-ui-sm bg-surface-2" />
                ))}
              </div>
            )}

            {!loading && documents.length === 0 && uploads.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted">
                As respostas vêm só dos documentos desta conversa, com a página ou o slide de onde saíram.
              </p>
            )}

            {documents.length > 0 && (
              <ul className="space-y-0.5">
                {documents.map((d) => {
                  const on = !excluded.has(d.id)
                  const pptx = d.file_type === 'pptx'
                  const Icon = pptx ? Presentation : FileText
                  return (
                    <li
                      key={d.id}
                      className={`group flex items-center gap-3 rounded-ui-sm px-2 py-2 transition-colors hover:bg-surface-2 ${
                        on ? '' : 'opacity-50'
                      }`}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ui-sm bg-surface-2 text-muted"
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-sm font-medium ${on ? '' : 'line-through decoration-muted/60'}`}
                          title={d.filename}
                        >
                          {d.filename}
                        </span>
                        <span className="block text-xs text-muted">
                          {pptx ? 'PPTX' : 'PDF'} · {d.n_chunks} blocos{d.library ? ` · base “${d.library}”` : ''}
                          {on ? '' : ' · ignorado'}
                        </span>
                      </span>
                      {togglable && (
                        <button
                          className={`icon-btn h-8 w-8 ${on ? 'text-fg' : ''}`}
                          onClick={() => onToggle(d.id)}
                          aria-pressed={on}
                          aria-label={on ? `Ignorar ${d.filename} nas respostas` : `Voltar a usar ${d.filename}`}
                          title={on ? 'Em uso — clica para ignorar nas respostas' : 'Ignorado — clica para voltar a usar'}
                        >
                          {on ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </button>
                      )}
                      {/* Os da base de dados gerem-se na própria base. */}
                      {!d.library && <button
                        className="icon-btn h-8 w-8 opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => onRemove(d)}
                        aria-label={`Remover ${d.filename}`}
                        title="Remover"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {togglable && (
            <p className="border-t border-line px-4 py-2.5 text-[0.72rem] text-muted">
              Usa o olho para escolher que documentos entram nas respostas.
            </p>
          )}
        </div>
      </aside>
    </>
  )
}

function UploadRow({ u, onDismiss }) {
  const working = u.status === 'queued' || u.status === 'indexing'
  const tone = {
    error: 'border-danger/40 bg-danger/10',
    warning: 'border-warn/40 bg-warn/10',
    duplicate: 'border-line/70 bg-surface-2/50',
    ok: 'border-ok/40 bg-ok/10',
  }[u.status] || 'border-line bg-surface-2'
  const detail = u.warnings?.length ? u.warnings.join(' ') : u.message
  return (
    <li className={`animate-in rounded-ui-sm border px-3 py-2 text-sm ${tone}`}>
      <div className="flex items-center gap-2">
        <span className="shrink-0">
          {working && <Spinner className="h-4 w-4 text-accent" />}
          {u.status === 'ok' && <Check className="h-4 w-4 text-ok" />}
          {u.status === 'warning' && <AlertTriangle className="h-4 w-4 text-warn" />}
          {u.status === 'duplicate' && <CopyCheck className="h-4 w-4 text-muted" />}
          {u.status === 'error' && <AlertTriangle className="h-4 w-4 text-danger" />}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium" title={u.name}>
          {u.name}
        </span>
        <span className="shrink-0 text-xs text-muted">
          {u.status === 'queued' && 'na fila'}
          {u.status === 'indexing' && 'a indexar…'}
          {u.status === 'ok' && 'pronto'}
        </span>
        {!working && (
          <button
            className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
            onClick={onDismiss}
            aria-label="Fechar aviso"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {working && (
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-line">
          <div className={`h-full rounded-full bg-fg/60 ${u.status === 'indexing' ? 'w-2/3 animate-pulse' : 'w-1/6'}`} />
        </div>
      )}
      {(u.status === 'error' || u.status === 'warning' || u.status === 'duplicate') && detail && (
        <p className={`mt-1 text-xs ${u.status === 'error' ? 'text-danger' : u.status === 'warning' ? 'text-warn' : 'text-muted'}`}>
          {detail}
        </p>
      )}
    </li>
  )
}

/** Botão "+" do campo de escrita: documentos e as ferramentas de casos práticos. */
export function AttachMenu({
  disabled, below, hasDocs, busy, onPick, onOpenTool, libraries = [], libraryId, onAttachLibrary, onManageLibraries,
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState('main') // 'main' | 'libraries' (escolher a base)
  const [libQuery, setLibQuery] = useState('')
  const root = useRef(null)
  const current = libraries.find((l) => l.id === libraryId)
  const q = libQuery.trim().toLowerCase()
  const shownLibs = q ? libraries.filter((l) => l.name.toLowerCase().includes(q)) : libraries

  useEffect(() => {
    if (open) return
    setView('main')
    setLibQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => root.current?.contains(e.target) || setOpen(false)
    // Esc no seletor de bases volta ao menu; no menu, fecha.
    const onKey = (e) => e.key === 'Escape' && (view === 'libraries' ? setView('main') : setOpen(false))
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, view])

  const pick = (fn) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div ref={root} className="relative">
      <button
        className={`focus-ring inline-flex h-8 w-8 items-center justify-center rounded-ui-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40 ${
          open ? 'bg-surface-2 text-fg' : ''
        }`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Anexar e ferramentas"
        title="Anexar documentos e ferramentas"
      >
        <Plus className={`h-[18px] w-[18px] transition-transform ${open ? 'rotate-45' : ''}`} />
      </button>
      {open && (
        <div role="menu" className={`glass animate-rise absolute left-0 z-20 max-h-[min(32rem,60vh)] ${below ? 'top-full mt-2' : 'bottom-full mb-2'} w-72 overflow-y-auto rounded-ui p-1 shadow-lg`}>
          {view === 'libraries' ? (
            <div>
              <div className="flex items-center gap-1 px-1 pb-1 pt-0.5">
                <button className="icon-btn h-7 w-7" onClick={() => setView('main')} aria-label="Voltar">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <p className="text-sm font-semibold">Base de dados</p>
              </div>
              <div className="relative px-1 pb-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input
                  autoFocus
                  value={libQuery}
                  onChange={(e) => setLibQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && shownLibs.length === 1) pick(() => onAttachLibrary(shownLibs[0].id))()
                  }}
                  placeholder="Procurar base de dados…"
                  className="input py-1.5 pl-8 text-sm"
                  aria-label="Procurar base de dados"
                />
              </div>
              <div className="max-h-56 overflow-y-auto">
                {shownLibs.map((l) => (
                  <MenuItem
                    key={l.id}
                    icon={Database}
                    label={l.name}
                    hint={`${l.n_documents} ${l.n_documents === 1 ? 'ficheiro' : 'ficheiros'}`}
                    checked={l.id === libraryId}
                    onClick={pick(() => onAttachLibrary(l.id === libraryId ? null : l.id))}
                  />
                ))}
                {shownLibs.length === 0 && (
                  <p className="px-3 py-3 text-sm text-muted">
                    {libraries.length ? `Nenhuma base com “${libQuery.trim()}”.` : 'Ainda não tens bases de dados.'}
                  </p>
                )}
              </div>
              <div className="my-1 h-px bg-line/60" />
              {current && <MenuItem icon={Unlink} label="Desassociar" hint={current.name} onClick={pick(() => onAttachLibrary(null))} />}
              <MenuItem
                icon={libraries.length ? Settings2 : Plus}
                label={libraries.length ? 'Gerir bases de dados…' : 'Criar base de dados…'}
                onClick={pick(onManageLibraries)}
              />
            </div>
          ) : (
          <>
          <MenuItem icon={UploadCloud} label="Carregar documentos" hint="PDF ou PPTX · até 50 MB" onClick={pick(onPick)} />
          <MenuItem
            icon={Database}
            label="Base de dados"
            hint={current ? `Associada: ${current.name}` : 'Associar uma base a esta conversa'}
            trailing={<ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
            onClick={() => setView('libraries')}
          />
          <div className="my-1 h-px bg-line/60" />
          <p className="px-2.5 pb-1 pt-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Casos práticos</p>
          <MenuItem
            icon={LayoutTemplate}
            label="Criar resposta-modelo"
            disabled={!hasDocs || busy}
            onClick={pick(() => onOpenTool('model'))}
          />
          <MenuItem
            icon={Scale}
            label="Resolver caso prático"
            disabled={!hasDocs || busy}
            onClick={pick(() => onOpenTool('solve'))}
          />
          {!hasDocs && <p className="px-2.5 pb-1.5 text-xs text-muted">Carrega documentos primeiro.</p>}
          </>
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({ icon: Icon, label, hint, disabled, checked, trailing, onClick }) {
  return (
    <button
      role="menuitem"
      className="focus-ring flex w-full items-center gap-3 rounded-ui-sm px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-45"
      onClick={onClick}
      disabled={disabled}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-medium ${checked ? 'text-accent' : ''}`}>{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      {checked && <Check className="h-4 w-4 shrink-0 text-accent" />}
      {trailing}
    </button>
  )
}
