import { useState } from 'react'
import { BookOpen, ChevronDown, FileText, Layers, Presentation } from 'lucide-react'
import { UNIT_LABEL } from '../fileTypes'

function pageLabel(s) {
  const unit = UNIT_LABEL[s.file_type] || 'Pág.'
  const end = s.page_end && s.page_end !== s.page_number ? `–${s.page_end}` : ''
  return `${unit} ${s.page_number}${end}`
}

/** Accordion "Fontes" no fim de cada resposta. */
export function SourceList({ sources, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!sources?.length) return null
  const files = new Set(sources.map((s) => s.source)).size
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="focus-ring inline-flex items-center gap-1.5 rounded-ui-sm px-1.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg"
        aria-expanded={open}
      >
        <BookOpen className="h-3.5 w-3.5" />
        {sources.length} {sources.length === 1 ? 'fonte' : 'fontes'}
        {files > 1 && ` · ${files} ficheiros`}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul className="animate-in mt-1.5 space-y-1.5">
          {sources.map((s, i) => (
            <SourceBadge key={`${s.doc_id}-${s.page_number}-${i}`} s={s} />
          ))}
        </ul>
      )}
    </div>
  )
}

export default function SourceBadge({ s }) {
  const [open, setOpen] = useState(false)
  const whole = s.score == null
  const Icon = whole ? Layers : s.file_type === 'pptx' ? Presentation : FileText
  const expandable = !!s.excerpt
  const kind = whole ? (s.section_title ? 'Secção inteira' : 'Documento inteiro') : null

  return (
    <li className="rounded-ui-sm border border-line bg-surface-2/40 text-sm">
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        className={`focus-ring flex w-full items-center gap-2 rounded-ui-sm px-2.5 py-1.5 text-left ${
          expandable ? 'hover:bg-surface-2' : 'cursor-default'
        }`}
        aria-expanded={expandable ? open : undefined}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{s.source}</span>
          <span className="text-muted"> · {pageLabel(s)}</span>
          {s.section_title && <span className="text-muted"> · {s.section_title}</span>}
        </span>
        {kind ? (
          <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[0.7rem] font-medium text-accent">{kind}</span>
        ) : (
          <span
            className="shrink-0 font-mono text-[0.7rem] text-muted"
            title="Semelhança com a pergunta (0 a 1)"
          >
            {s.score.toFixed(2)}
          </span>
        )}
        {expandable && (
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>
      {open && (
        <p className="animate-in border-t border-line px-3 py-2 text-[0.85em] leading-relaxed text-muted">
          {s.excerpt}
          {s.excerpt.length >= 400 && '…'}
        </p>
      )}
    </li>
  )
}
