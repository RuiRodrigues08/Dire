import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileText, LayoutTemplate, Presentation, Scale, X } from 'lucide-react'
import { Modal, Segmented } from './ui'

// Têm de coincidir com o backend (services/case_tools.py): é o texto que fica no histórico.
export const MODEL_ANSWER_LABEL = 'Criar resposta-modelo'
export const SOLVE_LABEL = 'Resolver caso prático'
const MAX_CASE_CHARS = 12000

const COPY = {
  model: {
    icon: LayoutTemplate,
    title: 'Criar resposta-modelo',
    intro:
      'Escolhe os documentos com casos práticos já resolvidos. O modelo analisa como cada resolução está construída e junta tudo num esqueleto comum, com o que escrever em cada parte.',
    refsLabel: 'Casos resolvidos a analisar',
    submit: 'Criar resposta-modelo',
  },
  solve: {
    icon: Scale,
    title: 'Resolver caso prático',
    intro:
      'Dá o enunciado do caso novo e escolhe os documentos de referência (matéria e casos resolvidos). O modelo segue a resposta-modelo desses documentos e cita a matéria que aplicar.',
    refsLabel: 'Documentos de referência',
    submit: 'Resolver caso',
  },
}

/** Escolha dos documentos (e do caso) para as ferramentas de casos práticos. */
export default function CaseToolsDialog({ kind, onClose, documents, onSubmit }) {
  const open = !!kind
  const copy = COPY[kind] || COPY.model
  const Icon = copy.icon
  const [selected, setSelected] = useState(() => new Set())
  const [source, setSource] = useState('text')
  const [caseText, setCaseText] = useState('')
  const [caseDoc, setCaseDoc] = useState('')

  useEffect(() => {
    if (!open) return
    setSelected(new Set(documents.map((d) => d.id)))
    setCaseDoc('')
  }, [open, kind, documents])

  const refs = useMemo(
    () => documents.filter((d) => selected.has(d.id) && !(kind === 'solve' && source === 'doc' && d.id === caseDoc)),
    [documents, selected, kind, source, caseDoc],
  )
  const caseOk = source === 'text' ? caseText.trim().length > 0 && caseText.length <= MAX_CASE_CHARS : !!caseDoc
  const valid = refs.length > 0 && (kind === 'model' || caseOk)

  function toggle(id) {
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  function submit() {
    if (!valid) return
    const names = refs.map((d) => d.filename).join(', ')
    if (kind === 'model') {
      onSubmit({ kind, body: { doc_ids: refs.map((d) => d.id) }, label: `${MODEL_ANSWER_LABEL} com base em: ${names}` })
    } else {
      const doc = documents.find((d) => d.id === caseDoc)
      const body = { doc_ids: refs.map((d) => d.id) }
      if (source === 'doc') body.case_doc_id = caseDoc
      else body.case_text = caseText.trim()
      const tail = source === 'doc' ? `Caso: ${doc?.filename}` : caseText.trim()
      onSubmit({ kind, body, label: `${SOLVE_LABEL} com base em: ${names}\n\n${tail}` })
      setCaseText('')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title}
      className="flex max-h-[100dvh] max-w-xl flex-col rounded-b-none sm:max-h-[90vh] sm:rounded-ui-lg"
    >
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ui-sm bg-accent/10 text-accent">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{copy.title}</h2>
          <p className="mt-0.5 text-sm text-muted">{copy.intro}</p>
        </div>
        <button className="icon-btn -mr-2 -mt-1" onClick={onClose} aria-label="Fechar">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {kind === 'solve' && (
          <section>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Caso a resolver</h3>
              <Segmented
                label="Origem do enunciado"
                value={source}
                onChange={setSource}
                options={[
                  { value: 'text', label: 'Colar enunciado' },
                  { value: 'doc', label: 'Documento carregado' },
                ]}
              />
            </div>
            {source === 'text' ? (
              <div className="mt-2">
                <textarea
                  value={caseText}
                  onChange={(e) => setCaseText(e.target.value)}
                  rows={7}
                  placeholder="Cola aqui o enunciado do caso prático novo…"
                  className="input resize-y text-sm"
                  aria-label="Enunciado do caso"
                  data-autofocus
                />
                {caseText.length > MAX_CASE_CHARS * 0.8 && (
                  <p className={`mt-1 text-right text-xs ${caseText.length > MAX_CASE_CHARS ? 'text-danger' : 'text-muted'}`}>
                    {caseText.length}/{MAX_CASE_CHARS}
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-2 space-y-1.5" role="radiogroup" aria-label="Documento com o caso">
                {documents.map((d) => (
                  <DocOption
                    key={d.id}
                    d={d}
                    type="radio"
                    checked={caseDoc === d.id}
                    onChange={() => setCaseDoc(d.id)}
                  />
                ))}
                <p className="text-xs text-muted">Carrega o enunciado pelo botão + do chat (ou arrasta-o para lá), se ainda não estiver lá.</p>
              </div>
            )}
          </section>
        )}

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium">{copy.refsLabel}</h3>
            <div className="flex gap-1 text-xs">
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setSelected(new Set(documents.map((d) => d.id)))}>
                Todos
              </button>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setSelected(new Set())}>
                Nenhum
              </button>
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            {documents.map((d) => {
              const isCase = kind === 'solve' && source === 'doc' && d.id === caseDoc
              return (
                <DocOption
                  key={d.id}
                  d={d}
                  type="checkbox"
                  checked={selected.has(d.id) && !isCase}
                  disabled={isCase}
                  note={isCase ? 'é o caso a resolver' : null}
                  onChange={() => toggle(d.id)}
                />
              )
            })}
          </div>
        </section>

        {kind === 'solve' ? (
          <p className="flex items-start gap-2 rounded-ui-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
            A resolução é um rascunho: o modelo aplica a matéria a factos novos e pode errar. Confirma cada passo nas
            fontes citadas.
          </p>
        ) : (
          <p className="text-xs text-muted">
            Pode demorar alguns minutos na primeira vez: o modelo lê cada documento. As análises ficam guardadas, por
            isso repetir com os mesmos documentos é imediato.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <span className="mr-auto text-xs text-muted">
          {refs.length} {refs.length === 1 ? 'documento' : 'documentos'}
        </span>
        <button className="btn-ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn-primary" onClick={submit} disabled={!valid}>
          <Icon className="h-4 w-4" /> {copy.submit}
        </button>
      </div>
    </Modal>
  )
}

function DocOption({ d, type, checked, disabled, note, onChange }) {
  const FileIcon = d.file_type === 'pptx' ? Presentation : FileText
  return (
    <label
      className={`flex items-center gap-2.5 rounded-ui-sm border px-3 py-2 text-sm transition-colors ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      } ${checked ? 'border-accent/50 bg-accent/5' : 'border-line hover:bg-surface-2/60'}`}
    >
      <input
        type={type}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
      />
      <FileIcon className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate" title={d.filename}>
        {d.filename}
      </span>
      {note ? (
        <span className="shrink-0 text-xs text-muted">{note}</span>
      ) : (
        <span className="shrink-0 text-xs text-muted">{d.n_chunks} blocos</span>
      )}
    </label>
  )
}
