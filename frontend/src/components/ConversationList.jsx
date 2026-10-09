import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, ChevronsLeft, Hourglass, MessageSquare, Pencil, Pin, PinOff, Plus, Search,
  Trash2, X,
} from 'lucide-react'
import { formatRelative } from './ui'

const EXPIRY_WARN_DAYS = 14

const DAY = 86400000

/** Agrupa as conversas não fixadas pela última atividade (Hoje, Ontem, …). */
function groupByDate(list) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const t0 = today.getTime()
  const buckets = [
    ['Hoje', t0],
    ['Ontem', t0 - DAY],
    ['Últimos 7 dias', t0 - 7 * DAY],
    ['Últimos 30 dias', t0 - 30 * DAY],
    ['Mais antigas', -Infinity],
  ]
  const out = buckets.map(([title]) => ({ title, items: [] }))
  for (const c of list) {
    const t = new Date(c.last_activity_at || 0).getTime()
    out[buckets.findIndex(([, from]) => t >= from)].items.push(c)
  }
  return out.filter((g) => g.items.length)
}

/** Com a barra recolhida fica só o logo, maior, separado do título por uma linha na cor de destaque; clicar abre a barra. */
export function BrandButton({ collapsed, onClick }) {
  return (
    <div className={`shrink-0 items-center gap-3 ${collapsed ? 'flex' : 'flex lg:hidden'}`}>
      <button
        onClick={onClick}
        className="focus-ring rounded-ui-sm transition-opacity hover:opacity-80"
        aria-label="Abrir conversas"
        title="Abrir conversas"
      >
        <img src="/logo-badge.png" alt="" className="h-11 w-11 rounded-ui-sm" />
      </button>
      <span className="h-9 w-[2px] rounded-full bg-accent" aria-hidden="true" />
    </div>
  )
}

export default function ConversationList({
  conversations, activeId, loading, onToggleCollapsed,
  onSelect, onNew, onRename, onTogglePin, onDelete, onClose,
}) {
  const [filter, setFilter] = useState('')

  const { pinned, groups, count } = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations
    return {
      pinned: list.filter((c) => c.pinned),
      groups: groupByDate(list.filter((c) => !c.pinned)),
      count: list.length,
    }
  }, [conversations, filter])

  const itemProps = { onSelect, onRename, onTogglePin, onDelete }

  return (
    // Painel flutuante (cantos arredondados, afastado das margens), com o logo e o nome no topo.
    <div className="h-full p-2 lg:pr-0">
    <nav className="flex h-full flex-col overflow-hidden rounded-[1.25rem] border border-line bg-surface shadow-sm" aria-label="Conversas">
      {/* Marca: 62px de altura para a linha ficar à mesma altura da do cabeçalho (72px = 8 de margem
          + 1 de borda + 62 + linha de 1px); o logo fica um pouco abaixo do topo e afastado da linha. */}
      <div className="flex h-[62px] shrink-0 items-center gap-3 px-3 pb-2.5 pt-2">
        <img src="/logo-badge.png" alt="" className="h-11 w-11 shrink-0 rounded-ui-sm" />
        <span className="min-w-0 flex-1 truncate text-lg font-extrabold tracking-tight">Dire</span>
        <button
          className="icon-btn hidden h-7 w-7 lg:inline-flex"
          onClick={onToggleCollapsed}
          aria-label="Recolher barra lateral"
          title="Recolher"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>
        {onClose && (
          <button className="icon-btn lg:hidden" onClick={onClose} aria-label="Fechar menu">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="mx-4 h-px shrink-0 bg-accent" />

      <div className="space-y-0.5 px-2.5 pb-1 pt-3">
        {/* Procurar: igual às outras linhas; ao clicar, o ícone ganha a cor de destaque e uma linha
            cresce por baixo (a altura não muda). */}
        <label className="group relative flex cursor-text items-center gap-3 overflow-hidden rounded-ui-sm px-3 py-2.5 transition-colors hover:bg-surface-2 focus-within:bg-surface-2">
          <Search className="h-[1.1rem] w-[1.1rem] shrink-0 text-muted transition-all duration-300 group-focus-within:-rotate-12 group-focus-within:scale-110 group-focus-within:text-accent" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setFilter(''), e.currentTarget.blur())}
            placeholder="Procurar"
            className="min-w-0 flex-1 bg-transparent p-0 text-sm font-semibold leading-5 text-fg outline-none placeholder:text-fg/85 placeholder:transition-colors focus:font-medium focus:placeholder:font-semibold focus:placeholder:text-muted"
            aria-label="Procurar conversas"
          />
          {filter && (
            <button
              type="button"
              className="animate-in -my-1 rounded-sm p-0.5 text-muted hover:text-fg"
              onClick={() => setFilter('')}
              aria-label="Limpar pesquisa"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <span
            className="pointer-events-none absolute bottom-0 left-3 right-3 h-[2px] origin-left scale-x-0 rounded-full bg-accent transition-transform duration-300 ease-out group-focus-within:scale-x-100"
            aria-hidden="true"
          />
        </label>
        <NavButton icon={Plus} label="Nova conversa" onClick={onNew} accent />
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-3">
        {loading && conversations.length === 0 && (
          <div className="space-y-2 px-1 pt-3" aria-hidden="true">
            {[70, 55, 80].map((w) => (
              <div key={w} className="h-8 animate-pulse rounded-ui-sm bg-surface-2" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {!loading && conversations.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted">Ainda não tens conversas.</p>
        )}
        {pinned.length > 0 && (
          <>
            <Section title="Fixadas" />
            {pinned.map((c) => (
              <Item key={c.id} c={c} active={c.id === activeId} {...itemProps} />
            ))}
          </>
        )}
        {groups.map((g) => (
          <div key={g.title}>
            <Section title={g.title} />
            {g.items.map((c) => (
              <Item key={c.id} c={c} active={c.id === activeId} {...itemProps} />
            ))}
          </div>
        ))}
        {filter && count === 0 && <p className="px-3 py-4 text-sm text-muted">Nenhuma conversa com “{filter}”.</p>}

      </div>

    </nav>
    </div>
  )
}

function NavButton({ icon: Icon, label, onClick, disabled, accent }) {
  return (
    <button
      className="focus-ring flex w-full items-center gap-3 rounded-ui-sm px-3 py-2.5 text-left text-sm font-semibold text-fg/85 transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className={`h-[1.1rem] w-[1.1rem] shrink-0 ${accent ? 'text-accent' : 'text-muted'}`} />
      {label}
    </button>
  )
}

function Section({ title }) {
  return <h3 className="px-3 pb-1.5 pt-4 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">{title}</h3>
}

function Item({ c, active, onSelect, onRename, onTogglePin, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(c.title)
  const input = useRef(null)

  useEffect(() => {
    if (editing) {
      setTitle(c.title)
      setTimeout(() => input.current?.select(), 0)
    }
  }, [editing, c.title])

  function commit() {
    const t = title.trim()
    setEditing(false)
    if (t && t !== c.title) onRename(c.id, t)
  }

  const expiring = !c.pinned && c.days_until_deletion != null && c.days_until_deletion < EXPIRY_WARN_DAYS

  if (editing) {
    return (
      <div className="mb-0.5 flex items-center gap-1 rounded-ui-sm bg-surface-2 px-1.5 py-1">
        <input
          ref={input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commit}
          maxLength={200}
          className="input px-2 py-1 text-sm"
          aria-label="Novo título"
        />
        <button className="icon-btn h-7 w-7" onMouseDown={(e) => e.preventDefault()} onClick={commit} aria-label="Guardar título">
          <Check className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div
      className={`group relative mb-0.5 flex items-center rounded-ui-sm transition-colors ${
        active ? 'bg-accent/10 text-accent' : 'text-fg/85 hover:bg-surface-2'
      }`}
    >
      <button
        onClick={() => onSelect(c.id)}
        onDoubleClick={() => setEditing(true)}
        className={`focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-ui-sm py-2 pl-3 text-left ${
          active ? 'pr-24' : 'pr-3 group-focus-within:pr-24 group-hover:pr-24'
        }`}
        aria-current={active ? 'page' : undefined}
        title={`${c.title} · ${formatRelative(c.last_activity_at)}`}
      >
        {c.pinned ? (
          <Pin className={`h-4 w-4 shrink-0 ${active ? '' : 'text-muted'}`} />
        ) : (
          <MessageSquare className={`h-4 w-4 shrink-0 ${active ? '' : 'text-muted'}`} />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
        {expiring && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[0.7rem] text-warn group-focus-within:hidden group-hover:hidden"
            title="Conversas sem mensagens há 60 dias são apagadas. Fixa-a para a manter."
          >
            <Hourglass className="h-3 w-3" />
            {c.days_until_deletion <= 0 ? 'hoje' : `${c.days_until_deletion} d`}
          </span>
        )}
      </button>
      <div
        className={`absolute right-1 items-center text-fg ${
          active ? 'flex' : 'hidden group-focus-within:flex group-hover:flex'
        }`}
      >
        <button className="icon-btn h-7 w-7" onClick={() => setEditing(true)} aria-label="Mudar o título" title="Mudar o título">
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          className="icon-btn h-7 w-7"
          onClick={() => onTogglePin(c)}
          aria-label={c.pinned ? 'Desafixar' : 'Fixar (não é apagada automaticamente)'}
          title={c.pinned ? 'Desafixar' : 'Fixar (não é apagada automaticamente)'}
        >
          {c.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
        <button
          className="icon-btn h-7 w-7 hover:text-danger"
          onClick={() => onDelete(c)}
          aria-label="Apagar conversa"
          title="Apagar conversa"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
