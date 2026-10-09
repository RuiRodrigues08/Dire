import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Check, Database, FileText, Link2, MessageSquare, Pencil, Plus, Presentation, Search, Trash2, Unlink,
  UploadCloud, X,
} from 'lucide-react'
import { api } from '../api'
import { ACCEPT, useFileDrop } from './DocumentTray'
import { shortTitle } from './TopBar'
import { useSettings } from './ThemeProvider'
import { Modal, Spinner, useConfirm, useToast } from './ui'

/*
  Bases de dados: conjuntos de ficheiros do perfil, indexados uma vez, que se associam a
  conversas (uma base por conversa). À esquerda a lista, à direita a base escolhida:
  ficheiros, nome, associar à conversa aberta e apagar.
*/

export default function LibraryDialog({ open, onClose, conversation, onAttach, onChanged, onOpenConversation }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [libraries, setLibraries] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [newName, setNewName] = useState('')

  const refresh = useCallback(async () => {
    try {
      const list = await api.libraries()
      setLibraries(list)
      return list
    } catch (e) {
      toast(e.message, 'error')
      return null
    } finally {
      setLoading(false)
    }
  }, [toast])

  // Ao abrir: recarrega e mostra a base da conversa (ou a primeira).
  useEffect(() => {
    if (!open) return
    setLoading(true)
    refresh().then((list) => {
      if (!list) return
      setSelected((cur) =>
        list.some((l) => l.id === cur) ? cur : conversation?.library_id || list[0]?.id || null,
      )
    })
  }, [open, refresh, conversation?.library_id])

  // A caixa de cima procura nas bases; se o nome não existir, Enter (ou o +) cria uma nova.
  const term = newName.trim()
  const exact = libraries.find((l) => l.name.toLowerCase() === term.toLowerCase())
  const shownLibraries = term ? libraries.filter((l) => l.name.toLowerCase().includes(term.toLowerCase())) : libraries

  async function create(e) {
    e.preventDefault()
    const name = term
    if (!name) return
    if (exact) {
      setSelected(exact.id)
      setNewName('')
      return
    }
    try {
      const lib = await api.createLibrary(name)
      setNewName('')
      await refresh()
      setSelected(lib.id)
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const lib = libraries.find((l) => l.id === selected) || null

  async function deleteLibrary(l) {
    const n = l.associated?.length || 0
    const ok = await confirm({
      title: 'Apagar base de dados?',
      message: `“${l.name}” é apagada com os ${l.n_documents} ficheiros${
        n ? ` e deixa de estar associada a ${n} ${n === 1 ? 'conversa' : 'conversas'}` : ''
      }. Não dá para desfazer.`,
      confirmLabel: 'Apagar',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteLibrary(l.id)
      const list = await refresh()
      if (l.id === selected) setSelected(list?.[0]?.id ?? null)
      onChanged?.()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Bases de dados" className="flex h-[min(42rem,92vh)] max-w-4xl flex-col overflow-hidden rounded-b-none sm:rounded-ui-lg">
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-ui-sm bg-accent/10 text-accent">
          <Database className="h-[1.1rem] w-[1.1rem]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold leading-tight">Bases de dados</h2>
          <p className="text-xs text-muted">Conjuntos de ficheiros que podes associar a qualquer conversa.</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {/* Lista */}
        <div className="flex max-h-48 shrink-0 flex-col border-b border-line sm:max-h-none sm:w-64 sm:border-b-0 sm:border-r">
          <form onSubmit={create} className="flex gap-1.5 p-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && newName && (e.stopPropagation(), setNewName(''))}
                placeholder="Procurar ou criar…"
                maxLength={60}
                className="input py-1.5 pl-8 text-sm"
                aria-label="Procurar ou criar base de dados"
              />
            </div>
            <button
              className="btn-primary h-[2.1rem] w-[2.1rem] shrink-0 p-0"
              disabled={!term || !!exact}
              aria-label="Criar base de dados"
              title={term ? `Criar “${term}”` : 'Escreve um nome para criar'}
            >
              <Plus className="h-4 w-4" />
            </button>
          </form>
          <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {loading && libraries.length === 0 && (
              <li className="flex justify-center py-6 text-muted"><Spinner /></li>
            )}
            {!loading && libraries.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted">Ainda não tens bases de dados. Cria a primeira acima.</li>
            )}
            {term && !exact && (
              <li>
                <button
                  onClick={create}
                  className="focus-ring flex w-full items-center gap-3 rounded-ui-sm border border-dashed border-line px-3 py-2.5 text-left text-sm hover:border-accent/60 hover:bg-surface-2"
                >
                  <Plus className="h-4 w-4 shrink-0 text-accent" />
                  <span className="min-w-0 truncate">
                    Criar <span className="font-semibold">“{term}”</span>
                  </span>
                </button>
              </li>
            )}
            {term && shownLibraries.length === 0 && (
              <li className="px-3 py-2 text-xs text-muted">Nenhuma base com esse nome.</li>
            )}
            {shownLibraries.map((l) => {
              const linked = conversation?.library_id === l.id
              return (
                <li key={l.id} className="group relative">
                  <button
                    onClick={() => setSelected(l.id)}
                    className={`focus-ring flex w-full items-center gap-3 rounded-ui-sm py-2.5 pl-3 pr-10 text-left transition-colors ${
                      l.id === selected ? 'bg-accent/10 text-accent' : 'text-fg/85 hover:bg-surface-2'
                    }`}
                  >
                    <Database className={`h-4 w-4 shrink-0 ${l.id === selected ? '' : 'text-muted'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{l.name}</span>
                      <span className="block text-xs text-muted">
                        {l.n_documents} {l.n_documents === 1 ? 'ficheiro' : 'ficheiros'}
                      </span>
                    </span>
                    {linked && (
                      <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[0.65rem] font-semibold text-accent group-focus-within:invisible group-hover:invisible" title="Associada à conversa aberta">
                        Em uso
                      </span>
                    )}
                  </button>
                  {/* Apagar: aparece ao passar o rato */}
                  <button
                    onClick={() => deleteLibrary(l)}
                    className="icon-btn absolute right-1.5 top-1/2 h-7 w-7 -translate-y-1/2 opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Apagar ${l.name}`}
                    title="Apagar base de dados"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Detalhe */}
        <div className="min-h-0 min-w-0 flex-1">
          {lib ? (
            <LibraryDetail
              key={lib.id}
              lib={lib}
              conversation={conversation}
              onAttach={onAttach}
              onChanged={async () => {
                await refresh()
                onChanged?.()
              }}
              onDelete={() => deleteLibrary(lib)}
              onOpenConversation={onOpenConversation}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted">
              <Database className="h-8 w-8" strokeWidth={1.5} />
              <p className="max-w-xs text-sm">
                Cria uma base de dados, junta-lhe ficheiros e associa-a às conversas onde a queres usar.
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function LibraryDetail({ lib, conversation, onAttach, onChanged, onDelete, onOpenConversation }) {
  const toast = useToast()
  const confirm = useConfirm()
  const { settings } = useSettings()
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploads, setUploads] = useState([]) // {key, name, status: 'queued'|'indexing'|'error', message}
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(lib.name)
  const fileInput = useRef(null)
  const linked = conversation?.library_id === lib.id

  const load = useCallback(async () => {
    try {
      setDocs(await api.libraryDocuments(lib.id))
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [lib.id, toast])

  useEffect(() => {
    load()
  }, [load])

  const addFiles = useCallback(
    async (fileList) => {
      const files = [...(fileList || [])].filter(Boolean)
      if (!files.length) return
      const items = files.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, status: 'queued' }))
      setUploads((u) => [...u, ...items])
      // Um de cada vez: a indexação usa o CPU todo.
      for (let i = 0; i < files.length; i++) {
        const key = items[i].key
        const set = (patch) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)))
        set({ status: 'indexing' })
        try {
          const r = await api.uploadLibraryDocument(lib.id, files[i])
          if (r.duplicate) toast(`“${r.filename}” já está nesta base de dados.`)
          else if (r.warnings?.length) toast(`${r.filename}: ${r.warnings.join(' ')}`)
          setUploads((u) => u.filter((x) => x.key !== key))
          await load()
          onChanged()
        } catch (e) {
          set({ status: 'error', message: e.message })
        }
      }
    },
    [lib.id, load, onChanged, toast],
  )
  const drop = useFileDrop(addFiles)

  async function rename() {
    setEditing(false)
    const n = name.trim()
    if (!n || n === lib.name) return setName(lib.name)
    try {
      await api.renameLibrary(lib.id, n)
      onChanged()
    } catch (e) {
      toast(e.message, 'error')
      setName(lib.name)
    }
  }

  async function removeDoc(d) {
    if (settings.confirm_delete) {
      const ok = await confirm({
        title: 'Remover ficheiro?',
        message: `“${d.filename}” sai da base “${lib.name}” e deixa de ser usado em todas as conversas associadas.`,
        confirmLabel: 'Remover',
        danger: true,
      })
      if (!ok) return
    }
    try {
      await api.deleteLibraryDocument(lib.id, d.id)
      await load()
      onChanged()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  // Pesquisa: o nome filtra logo; o conteúdo pesquisa-se no servidor (por significado) a partir de 3 letras.
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState([])
  const [searching, setSearching] = useState(false)
  const q = query.trim()
  const shownDocs = q ? docs.filter((d) => d.filename.toLowerCase().includes(q.toLowerCase())) : docs
  useEffect(() => {
    if (q.length < 3) {
      setHits([])
      return
    }
    let alive = true
    setSearching(true)
    const t = setTimeout(() => {
      api
        .searchLibrary(lib.id, q)
        .then((r) => alive && setHits(r))
        .catch((e) => alive && toast(e.message, 'error'))
        .finally(() => alive && setSearching(false))
    }, 350)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, lib.id, toast])

  const busy = uploads.some((u) => u.status !== 'error')

  return (
    <div className="relative flex h-full flex-col" {...drop.handlers}>
      {drop.over && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-ui border border-dashed border-accent/60 bg-surface/95">
          <p className="font-medium">Larga para juntar a “{lib.name}”</p>
        </div>
      )}

      <div className="border-b border-line px-5 py-4">
        <div className="flex items-center gap-2">
          {editing ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename()
                if (e.key === 'Escape') {
                  setName(lib.name)
                  setEditing(false)
                }
              }}
              maxLength={60}
              className="input py-1 text-lg font-semibold"
              aria-label="Nome da base de dados"
            />
          ) : (
            <>
              <h3 className="min-w-0 truncate text-lg font-semibold">{lib.name}</h3>
              <button className="icon-btn h-7 w-7" onClick={() => setEditing(true)} aria-label="Mudar o nome" title="Mudar o nome">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span>{lib.n_documents} {lib.n_documents === 1 ? 'ficheiro' : 'ficheiros'}</span>
          <span aria-hidden="true">·</span>
          <ConversationsHover
            label="Associada a"
            hint="Conversas que pesquisam nesta base agora."
            items={lib.associated || []}
            onOpen={onOpenConversation}
          />
          <span aria-hidden="true">·</span>
          <ConversationsHover
            label="Usada em"
            hint="Conversas com respostas tiradas dos ficheiros desta base."
            items={lib.used || []}
            onOpen={onOpenConversation}
          />
        </div>

        {conversation && (
          <div className={`mt-3 flex flex-wrap items-center gap-3 rounded-ui-sm border px-3 py-2.5 ${linked ? 'border-accent/40 bg-accent/5' : 'border-line'}`}>
            <span className="min-w-0 flex-1 text-sm">
              {linked ? (
                <>
                  <Check className="mr-1.5 inline h-4 w-4 text-accent" />
                  Associada a <span className="font-semibold">“{shortTitle(conversation.title, 40)}”</span>
                </>
              ) : conversation.library_id ? (
                'A conversa aberta usa outra base de dados. Associar esta substitui-a.'
              ) : (
                <>Usar nesta conversa: <span className="font-semibold">“{shortTitle(conversation.title, 40)}”</span></>
              )}
            </span>
            {linked ? (
              <button className="btn-outline px-3 py-1.5 text-sm" onClick={() => onAttach(null)}>
                <Unlink className="h-4 w-4" /> Desassociar
              </button>
            ) : (
              <button className="btn-primary px-3 py-1.5 text-sm" onClick={() => onAttach(lib.id)}>
                <Link2 className="h-4 w-4" /> Associar
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <button
          onClick={() => fileInput.current?.click()}
          className="focus-ring flex w-full items-center gap-3 rounded-ui border border-dashed border-line px-4 py-3.5 text-left transition-colors hover:border-accent/60 hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center text-muted">
            {busy ? <Spinner className="h-5 w-5" /> : <UploadCloud className="h-5 w-5" />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">{busy ? 'A indexar…' : 'Juntar ficheiros'}</span>
            <span className="block text-xs text-muted">PDF ou PPTX · arrasta para aqui ou clica</span>
          </span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {uploads.length > 0 && (
          <ul className="mt-3 space-y-1" aria-label="Carregamentos">
            {uploads.map((u) => (
              <li key={u.key} className="flex items-center gap-3 rounded-ui-sm px-2 py-2 text-sm">
                {u.status === 'error' ? (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
                ) : (
                  <Spinner className="h-4 w-4 shrink-0 text-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{u.name}</span>
                  <span className={`block text-xs ${u.status === 'error' ? 'text-danger' : 'text-muted'}`}>
                    {u.status === 'error' ? u.message : u.status === 'queued' ? 'Na fila' : 'A indexar'}
                  </span>
                </span>
                {u.status === 'error' && (
                  <button
                    className="icon-btn h-7 w-7"
                    onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}
                    aria-label="Fechar"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {docs.length > 0 && (
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))}
              placeholder="Pesquisar nos ficheiros desta base…"
              className="input py-2 pl-9 text-sm"
              aria-label="Pesquisar nesta base de dados"
            />
            {searching && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />}
          </div>
        )}

        {q.length >= 3 && (
          <div className="mt-3">
            <p className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">No conteúdo</p>
            {hits.length === 0 && !searching && <p className="px-2 py-2 text-sm text-muted">Nada encontrado no conteúdo.</p>}
            <ul className="space-y-1">
              {hits.map((h) => (
                <li key={`${h.doc_id}:${h.page_number}`} className="rounded-ui-sm border border-line px-3 py-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    {h.file_type === 'pptx' ? <Presentation className="h-3.5 w-3.5 text-muted" /> : <FileText className="h-3.5 w-3.5 text-muted" />}
                    <span className="min-w-0 truncate">{h.filename}</span>
                    <span className="shrink-0 text-muted">· {h.file_type === 'pptx' ? 'Slide' : 'Pág.'} {h.page_number}</span>
                  </p>
                  <p className="mt-1 line-clamp-3 text-sm text-fg/85"><Highlight text={h.snippet} query={q} /></p>
                </li>
              ))}
            </ul>
            <p className="mb-1.5 mt-4 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Ficheiros</p>
          </div>
        )}

        <ul className="mt-3 space-y-0.5">
          {q && shownDocs.length === 0 && (
            <li className="py-3 text-center text-sm text-muted">Nenhum ficheiro com “{q}” no nome.</li>
          )}
          {loading && docs.length === 0 && (
            <li className="flex justify-center py-6 text-muted"><Spinner /></li>
          )}
          {!loading && docs.length === 0 && uploads.length === 0 && (
            <li className="py-6 text-center text-sm text-muted">Esta base ainda não tem ficheiros.</li>
          )}
          {shownDocs.map((d) => {
            const pptx = d.file_type === 'pptx'
            const Icon = pptx ? Presentation : FileText
            return (
              <li key={d.id} className="group flex items-center gap-3 rounded-ui-sm px-2 py-2 transition-colors hover:bg-surface-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ui-sm bg-surface-2 text-muted">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={d.filename}>{d.filename}</span>
                  <span className="block text-xs text-muted">{pptx ? 'Apresentação PPTX' : 'Documento PDF'}</span>
                </span>
                <button
                  className="icon-btn h-8 w-8 opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => removeDoc(d)}
                  aria-label={`Remover ${d.filename}`}
                  title="Remover"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="flex justify-end border-t border-line px-5 py-3">
        <button className="btn-ghost text-sm text-danger hover:bg-danger/10" onClick={onDelete}>
          <Trash2 className="h-4 w-4" /> Apagar base de dados
        </button>
      </div>
    </div>
  )
}

/** "Associada a N conversas" / "Usada em N conversas": ao passar o rato mostra quais (e abre-as). */
function ConversationsHover({ label, hint, items, onOpen }) {
  const n = items.length
  return (
    <span className="group/conv relative">
      <span
        tabIndex={0}
        className={`focus-ring cursor-default rounded-sm underline decoration-dotted underline-offset-2 ${n ? 'hover:text-fg' : ''}`}
      >
        {label} {n} {n === 1 ? 'conversa' : 'conversas'}
      </span>
      <span className="invisible absolute left-0 top-full z-30 pt-1.5 opacity-0 transition-opacity group-focus-within/conv:visible group-focus-within/conv:opacity-100 group-hover/conv:visible group-hover/conv:opacity-100">
        <span className="card block w-72 p-1.5 shadow-xl">
          <span className="block px-2 pb-1 pt-0.5 text-[0.7rem] text-muted">{hint}</span>
          {n === 0 ? (
            <span className="block px-2 py-1.5 text-sm text-muted">Nenhuma ainda.</span>
          ) : (
            items.map((c) => (
              <button
                key={c.id}
                onClick={() => onOpen?.(c.id)}
                className="focus-ring flex w-full items-center gap-2 rounded-ui-sm px-2 py-1.5 text-left text-sm text-fg hover:bg-surface-2"
                title="Abrir conversa"
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 truncate">{c.title}</span>
              </button>
            ))
          )}
        </span>
      </span>
    </span>
  )
}

/** Realça no excerto as palavras pesquisadas. */
function Highlight({ text, query }) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3)
  if (!words.length) return text
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(re).map((part, i) =>
    i % 2 ? <mark key={i} className="rounded-sm bg-accent/20 px-0.5 text-fg">{part}</mark> : part,
  )
}
