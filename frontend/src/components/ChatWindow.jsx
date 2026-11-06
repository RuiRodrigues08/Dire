import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, ArrowDown, ArrowRight, Check, ChevronDown, Copy, FileSearch, Info, LayoutTemplate,
  ListChecks, RotateCcw, Scale, Search, Sparkles, Square,
} from 'lucide-react'
import { ApiError, api, streamChat, streamNdjson } from '../api'
import { MODEL_ANSWER_LABEL, SOLVE_LABEL } from './CaseToolsDialog'
import { useSettings } from './ThemeProvider'
import { AttachMenu, DocumentPanel, DropOverlay, useFileDrop } from './DocumentTray'
import { SourceList } from './SourceBadge'
import { shortTitle } from './TopBar'
import { Spinner, useToast } from './ui'

// Têm de coincidir com o backend (core/prompts.py e services/rag_engine.py).
const REFUSAL = 'Com base nos documentos fornecidos, não existe informação suficiente'
const TOPIC_MENU_INTRO = 'Sobre que tema queres o resumo?'

const SUGGESTIONS = [
  { icon: ListChecks, text: 'Quais são os temas abordados?' },
  { icon: Sparkles, text: 'Faz um resumo' },
  { icon: FileSearch, text: 'Quais são os títulos dos slides?' },
]

const ERRORS = {
  limit_reached: 'Foi atingido o limite deste link.',
  timeout: 'A resposta demorou demasiado. Tenta de novo.',
  llm_unavailable: 'O modelo local não está disponível (o Ollama está a correr?).',
  internal: 'Erro interno ao gerar a resposta.',
}

/** Tipo de uma pergunta guardada: chat normal ou uma das ferramentas de casos práticos. */
function toolKind(content) {
  if (content?.startsWith(MODEL_ANSWER_LABEL)) return 'model'
  if (content?.startsWith(SOLVE_LABEL)) return 'solve'
  return null
}

export default function ChatWindow({
  conversation, documents, docsLoading, excluded, docs, addFiles, pickFiles, docsOpen, setDocsOpen, onOpenTool,
  brand, actions, onActivity, onBudget, task, onTaskTaken,
  userName, onStartWith, pendingQuery, onPendingTaken, libraries, library, onAttachLibrary, onManageLibraries,
}) {
  const { settings } = useSettings()
  const toast = useToast()
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadedCid, setLoadedCid] = useState(null) // conversa cujas mensagens já chegaram
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef(null)
  const scroller = useRef(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const cid = conversation?.id
  // Os documentos (carregamentos, painel) são geridos no App, partilhados com a barra lateral.
  const closeDocs = useCallback(() => setDocsOpen(false), [setDocsOpen])
  const drop = useFileDrop(addFiles)

  // Carregar mensagens ao mudar de conversa (e cancelar uma resposta a meio).
  useEffect(() => {
    abortRef.current?.abort()
    setMessages([])
    setStreaming(false)
    setLoadedCid(null)
    if (!cid) return
    let alive = true
    setLoading(true)
    api
      .messages(cid)
      .then((m) => alive && setMessages(m))
      .catch((e) => alive && toast(e.message, 'error'))
      .finally(() => {
        if (!alive) return
        setLoading(false)
        setLoadedCid(cid)
      })
    stick.current = true
    return () => {
      alive = false
    }
  }, [cid, toast])

  useEffect(() => () => abortRef.current?.abort(), [])

  // Manter o fim à vista enquanto a resposta chega, se o utilizador estiver lá em baixo.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  function onScroll() {
    const el = scroller.current
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = near
    setShowJump(!near)
  }

  /** Mostra a pergunta e vai preenchendo a resposta com os eventos do stream. */
  const run = useCallback(
    async ({ userContent, start, query, task: taskSpec }) => {
      const userMsg = { id: `u-${Date.now()}`, role: 'user', content: userContent }
      const botId = `a-${Date.now()}`
      setMessages((m) => [
        ...m, userMsg, { id: botId, role: 'assistant', content: '', pending: true, query, task: taskSpec },
      ])
      stick.current = true
      setStreaming(true)
      const patch = (p) =>
        setMessages((m) => m.map((x) => (x.id === botId ? { ...x, ...(typeof p === 'function' ? p(x) : p) } : x)))

      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        for await (const ev of start(ctrl.signal)) {
          if (ev.type === 'queue') patch({ queue: ev.position })
          else if (ev.type === 'progress') patch({ progress: ev.message, queue: null })
          else if (ev.type === 'rewrite') patch({ rewritten: ev.data })
          else if (ev.type === 'token') patch((x) => ({ content: x.content + ev.data, queue: null }))
          else if (ev.type === 'sources') patch({ sources: ev.data })
          else if (ev.type === 'done') {
            patch({ pending: false, prompt_tokens: ev.usage?.prompt_tokens, gen_tokens: ev.usage?.gen_tokens })
            onBudget?.({ questions_left: ev.questions_left, tokens_left: ev.tokens_left })
            onActivity?.()
          } else if (ev.type === 'error') {
            patch({ pending: false, error: ev.message || ERRORS[ev.code] || 'Erro ao gerar a resposta.' })
          }
        }
        patch((x) => (x.pending ? { pending: false } : {}))
      } catch (e) {
        if (e.name === 'AbortError') {
          patch((x) => ({ pending: false, stopped: true, content: x.content }))
        } else {
          const msg = e instanceof ApiError ? e.message : 'Ligação interrompida.'
          patch({ pending: false, error: msg })
          if (e instanceof ApiError && e.status === 429) onBudget?.({ questions_left: 0 })
        }
      } finally {
        setStreaming(false)
        abortRef.current = null
      }
    },
    [onActivity, onBudget],
  )

  const send = useCallback(
    (text) => {
      const query = text.trim()
      if (!query || streaming) return
      // Só se pergunta com conteúdo: ficheiros anexados ou uma base de dados associada.
      if (!cid || documents.length === 0) {
        toast(
          docs.busy ? 'Aguarda que os ficheiros terminem de ser indexados.' : 'Anexa um ficheiro ou associa uma base de dados antes de perguntar.',
          'error',
        )
        return
      }
      const docIds = excluded.size ? documents.filter((d) => !excluded.has(d.id)).map((d) => d.id) : null
      if (docIds && docIds.length === 0) {
        toast('Liga pelo menos um documento para perguntar.', 'error')
        return
      }
      run({ userContent: query, query, start: (signal) => streamChat(cid, query, docIds, signal) })
    },
    [cid, streaming, documents, excluded, toast, run, docs.busy],
  )

  // Pergunta feita no início: corre quando a conversa nova estiver carregada.
  useEffect(() => {
    if (!pendingQuery || !cid || loadedCid !== cid || streaming) return
    onPendingTaken?.()
    send(pendingQuery)
  }, [pendingQuery, cid, loadedCid, streaming, onPendingTaken, send])

  const runTask = useCallback(
    (t) => {
      if (!cid) return
      run({ userContent: t.label, task: t, start: (signal) => streamNdjson(t.path, t.body, signal) })
    },
    [cid, run],
  )

  // Ferramentas pedidas a partir do painel de documentos.
  useEffect(() => {
    if (!task || streaming || loading || !cid) return
    onTaskTaken?.()
    runTask(task)
  }, [task, streaming, loading, cid, onTaskTaken, runTask])

  function retry(msg) {
    setMessages((m) => {
      const i = m.findIndex((x) => x.id === msg.id)
      return m.slice(0, Math.max(0, i - 1))
    })
    setTimeout(() => (msg.task ? runTask(msg.task) : send(msg.query)), 0)
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const noDocs = !loading && !docsLoading && documents.length === 0
  const usedDocs = documents.filter((d) => !excluded.has(d.id)).length
  // Sem mensagens: saudação ao centro com o campo de escrita logo abaixo (como no Claude).
  const empty = !loading && messages.length === 0

  const composer = (centered) => (
    <Composer
      centered={centered}
      streaming={streaming}
      sendWith={settings.send_with}
      canSend={documents.length > 0}
      onSend={send}
      onStop={() => abortRef.current?.abort()}
      placeholder={noDocs ? 'Junta documentos com o + ou escreve a tua pergunta…' : 'Pergunta sobre os teus documentos…'}
      attach={
        <AttachMenu
          below={centered}
          hasDocs={documents.length > 0}
          busy={docs.busy}
          onPick={pickFiles}
          onOpenTool={onOpenTool}
          libraries={libraries}
          libraryId={library?.id}
          onAttachLibrary={onAttachLibrary}
          onManageLibraries={onManageLibraries}
        />
      }
    />
  )

  return (
    <Shell
      brand={brand}
      actions={actions}
      title={conversation?.title || 'Nova conversa'}
      page={conversation ? 'Conversa' : 'Início'}
      subtitle={
        !conversation ? null : documents.length
          ? `${usedDocs === documents.length ? documents.length : `${usedDocs} de ${documents.length}`} ${documents.length === 1 ? 'documento' : 'documentos'}`
          : 'Sem documentos'
      }
      onSubtitle={() => setDocsOpen((o) => !o)}
      subtitleActive={docsOpen}
      dropHandlers={drop.handlers}
      aside={
        <DocumentPanel
          open={docsOpen}
          onClose={closeDocs}
          documents={documents}
          excluded={excluded}
          uploads={docs.uploads}
          busy={docs.busy}
          loading={docsLoading}
          onPick={pickFiles}
          onToggle={docs.toggle}
          onRemove={docs.remove}
          onDismiss={docs.dismiss}
        />
      }
    >
      <DropOverlay show={drop.over} />
      {empty ? (
        <Greeting
          name={userName}
          documents={noDocs ? [] : documents}
          library={library}
          busy={docs.busy}
          onAsk={send}
          composer={composer(true)}
        />
      ) : (
      <>
      <div ref={scroller} onScroll={onScroll} className="relative flex-1 overflow-y-auto">
        <div className="gap-d mx-auto flex w-full max-w-chat flex-col px-4 pb-6 pt-5">
          {loading && (
            <div className="flex justify-center py-10 text-muted">
              <Spinner className="h-5 w-5" />
            </div>
          )}

          {messages.map((m, i) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} m={m} style={settings.message_style} />
            ) : (
              <AssistantMessage
                key={m.id}
                m={m}
                kind={toolKind(messages[i - 1]?.content)}
                style={settings.message_style}
                sourcesOpen={settings.sources_open}
                showTokens={settings.show_tokens}
                interactive={m === lastAssistant && !streaming}
                onChoose={send}
                onRetry={() => retry(m)}
              />
            ),
          )}
        </div>
      </div>

      {showJump && (
        <button
          onClick={() => {
            stick.current = true
            scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
          }}
          className="glass focus-ring absolute bottom-32 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full text-muted hover:text-fg"
          aria-label="Ir para o fim"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}

      {composer(false)}
      </>
      )}
    </Shell>
  )
}

function Shell({ brand, actions, title, page, subtitle, onSubtitle, subtitleActive, dropHandlers, aside, children }) {
  return (
    <section className="relative flex h-full min-w-0 flex-1" {...dropHandlers}>
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        {/* Cabeçalho: título da página (o da conversa, cortado) e, por baixo, a página e os
            documentos. À direita, as ações (base de dados, tema, perfil). À esquerda, o logo
            quando a barra lateral está recolhida. */}
        <header className="flex h-[4.5rem] shrink-0 items-center gap-3 border-b border-line px-4 sm:px-5">
          {brand}
          <div className="min-w-0 flex-1 overflow-hidden leading-tight">
            <h1 className="truncate text-base font-bold sm:text-lg" title={title}>{shortTitle(title)}</h1>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
              <span className="shrink-0">{page}</span>
              {subtitle && <span aria-hidden="true">·</span>}
              {subtitle &&
                (onSubtitle ? (
                  <button
                    className={`focus-ring -my-0.5 inline-flex min-w-0 items-center truncate rounded-full border px-2 py-px font-mono text-[0.68rem] transition-colors ${
                      subtitleActive ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line bg-surface-2 text-muted hover:text-fg'
                    }`}
                    onClick={onSubtitle}
                    aria-expanded={subtitleActive}
                    title="Documentos da conversa"
                  >
                    {subtitle}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{subtitle}</span>
                ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </header>
        {children}
      </div>
      {aside}
    </section>
  )
}

const pick = (list) => list[Math.floor(Math.random() * list.length)]

/**
 * Saudação e pergunta do ecrã de entrada, conforme a hora e o dia da semana.
 * `{n}` é o primeiro nome. Escolhe-se uma ao abrir (não muda enquanto se escreve).
 */
function greetingFor(date = new Date()) {
  const h = date.getHours()
  const day = date.getDay() // 0 = domingo
  let titles
  let questions
  if (h < 6) {
    titles = ['Ainda acordado, {n}?', 'A queimar as pestanas, {n}?', 'Noite longa, {n}?']
    questions = ['Uma última revisão antes de dormir?', 'O que ficou por perceber hoje?', 'Vamos despachar isso depressa?']
  } else if (h < 12) {
    titles = ['Bom dia, {n}', 'Bom dia, {n}!']
    questions = ['O que vamos estudar hoje?', 'Por onde começamos esta manhã?', 'Que matéria queres despachar hoje?']
  } else if (h < 14) {
    titles = ['Boa tarde, {n}', 'Olá, {n}']
    questions = ['Uma pausa para rever a matéria?', 'O que queres rever depois do almoço?', 'O que vamos fazer hoje?']
  } else if (h < 20) {
    titles = ['Boa tarde, {n}']
    questions = ['O que estás a pensar estudar ou pesquisar?', 'Em que trabalho estás agora?', 'Que dúvida resolvemos agora?']
  } else {
    titles = ['Boa noite, {n}']
    questions = ['O que queres rever antes de amanhã?', 'Ainda há tempo para uma revisão. O que vai ser?', 'Em que estás a pensar estudar?']
  }
  if (day === 1 && h >= 6 && h < 14) questions = [...questions, 'Nova semana, nova matéria. Por onde começamos?']
  if (day === 5 && h >= 12) questions = [...questions, 'Sexta-feira! Fechamos a semana com uma revisão?']
  if ((day === 0 || day === 6) && h >= 6) questions = [...questions, 'A estudar ao fim de semana? O que vai ser hoje?']
  return { title: pick(titles), question: pick(questions) }
}

/** Ecrã de entrada de cada conversa (e do início): saudação, campo de escrita e o que fazer a seguir. */
function Greeting({ name, documents, library, busy, onAsk, composer }) {
  const first = (name || '').trim().split(/\s+/)[0]
  const [{ title, question }] = useState(greetingFor)
  const heading = first ? title.replace('{n}', first) : title.replace(/,? \{n\}/, '')
  const n = documents.length
  return (
    <div className="relative z-10 flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-[12vh] pt-6">
      <div className="animate-rise w-full max-w-chat">
        <h2 className="flex items-center justify-center gap-3 text-center font-serif text-3xl tracking-tight text-fg/90 sm:text-4xl">
          <img src="/logo-badge.png" alt="" className="h-11 w-11 shrink-0 rounded-ui-sm" />
          {heading}
        </h2>
        <p className="mb-7 mt-2 text-center font-serif text-lg text-muted sm:text-xl">{question}</p>
        {composer}
        {n > 0 ? (
          <>
            <p className="mt-4 text-center text-sm text-muted">
              {n} {n === 1 ? 'documento pronto' : 'documentos prontos'}
              {library ? ` · base “${library.name}”` : ''}
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map(({ icon: Icon, text }) => (
                <button
                  key={text}
                  className="focus-ring inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm transition-colors hover:border-accent/50 hover:bg-accent/5"
                  onClick={() => onAsk(text)}
                >
                  <Icon className="h-4 w-4 text-accent" />
                  {text}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="mx-auto mt-4 max-w-md text-center text-sm text-muted">
            {busy
              ? 'A preparar os teus documentos…'
              : 'Junta PDFs ou PPTX com o + (ou arrasta-os para aqui), ou associa uma base de dados. As respostas vêm só desses ficheiros, com a página ou o slide.'}
          </p>
        )}
      </div>
    </div>
  )
}

/** Moldura das mensagens do assistente, conforme o estilo escolhido nas definições. */
function AssistantFrame({ style, children }) {
  if (style === 'modern') {
    return (
      <div className="animate-in border-b border-line/60 pb-6">
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted">
          <img src="/logo-badge.png" alt="" className="h-5 w-5 rounded" />
          Dire
        </p>
        {children}
      </div>
    )
  }
  if (style === 'clean') {
    return (
      <div className="animate-in border-b border-line/60 pb-5">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-accent">Resposta</p>
        {children}
      </div>
    )
  }
  return (
    <div className="animate-in flex">
      <div className="min-w-0 max-w-[85%] rounded-ui-lg border border-line bg-surface px-4 py-3 text-sm">{children}</div>
    </div>
  )
}

function UserMessage({ m, style }) {
  const kind = toolKind(m.content)
  if (kind) return <ToolRequest m={m} kind={kind} style={style} />
  if (style === 'modern') {
    return (
      <div className="animate-in pt-3">
        <p className="whitespace-pre-wrap text-lg font-semibold leading-snug tracking-tight">{m.content}</p>
      </div>
    )
  }
  if (style === 'clean') {
    return (
      <div className="animate-in">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Pergunta</p>
        <p className="whitespace-pre-wrap font-medium">{m.content}</p>
      </div>
    )
  }
  return (
    <div className="animate-in flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-ui-lg bg-accent px-3.5 py-2 text-sm text-accent-fg">
        {m.content}
      </div>
    </div>
  )
}

/** Pedido de uma ferramenta: a primeira linha diz o quê; o enunciado do caso fica recolhido. */
function ToolRequest({ m, kind, style }) {
  const [open, setOpen] = useState(false)
  const [head, ...rest] = m.content.split('\n\n')
  const detail = rest.join('\n\n')
  const Icon = kind === 'model' ? LayoutTemplate : Scale
  const [title, docsList] = head.split(' com base em: ')
  return (
    <div className={`animate-in flex ${style === 'bubbles' ? 'justify-end' : ''}`}>
      <div className="glass pad-d w-full max-w-[85%] rounded-ui-lg">
        <p className="flex items-center gap-2 font-medium">
          <Icon className="h-4 w-4 shrink-0 text-accent" /> {title}
        </p>
        {docsList && <p className="mt-1 text-xs text-muted">Com base em: {docsList}</p>}
        {detail && (
          <>
            <p className={`mt-2 whitespace-pre-wrap text-sm ${open ? '' : 'line-clamp-3'}`}>{detail}</p>
            {detail.length > 200 && (
              <button
                className="focus-ring mt-1 inline-flex items-center gap-1 rounded-ui-sm text-xs font-medium text-accent"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
              >
                {open ? 'Ver menos' : 'Ver enunciado completo'}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({
  m, kind, style, sourcesOpen, showTokens, interactive, onChoose, onRetry,
}) {
  const refused = m.content.startsWith(REFUSAL)
  const isMenu = m.content.startsWith(TOPIC_MENU_INTRO)
  const waiting = m.pending && !m.content

  const body = (
    <>
      {kind === 'model' && (
        <p className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
          <LayoutTemplate className="h-3.5 w-3.5" /> Resposta-modelo
        </p>
      )}
      {kind === 'solve' && (
        <p className="mb-3 flex items-start gap-2 rounded-ui-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
          Rascunho: o modelo aplicou a matéria a um caso novo e pode ter errado. Confirma cada passo nas fontes.
        </p>
      )}
      {m.rewritten && (
        <p className="mb-2 flex items-start gap-1.5 text-xs text-muted">
          <Search className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Pesquisei por: <span className="italic">{m.rewritten}</span>
          </span>
        </p>
      )}

      {waiting && (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner className="h-4 w-4 text-accent" />
          {m.queue ? `Na fila · posição ${m.queue}` : m.progress || 'A procurar nos documentos…'}
        </p>
      )}

      {!waiting && refused && (
        <p className="flex items-start gap-2 text-muted">
          <Info className="mt-1 h-4 w-4 shrink-0" />
          <span>{m.content}</span>
        </p>
      )}

      {!waiting && !refused && isMenu && !m.pending && (
        <TopicMenu content={m.content} interactive={interactive} onChoose={onChoose} />
      )}

      {!waiting && !refused && (!isMenu || m.pending) && <Markdown text={m.content} streaming={m.pending} sources={m.sources} />}

      {m.stopped && <p className="mt-2 text-xs text-muted">Resposta interrompida.</p>}

      {m.error && (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded-ui-sm border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{m.error}</span>
          {(m.query || m.task) && interactive && (
            <button className="btn-ghost px-2 py-1 text-xs text-danger" onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" /> Tentar de novo
            </button>
          )}
        </div>
      )}

      {!m.pending && !refused && <SourceList sources={m.sources} defaultOpen={sourcesOpen} />}

      {!m.pending && m.content && (
        <div className="mt-2 flex items-center gap-3 text-xs text-muted">
          <CopyButton text={copyText(m.content)} />
          {showTokens && (m.prompt_tokens != null || m.gen_tokens != null) && (
            <span className="font-mono">
              {m.prompt_tokens ?? 0} + {m.gen_tokens ?? 0} tokens
            </span>
          )}
        </div>
      )}
    </>
  )

  return <AssistantFrame style={style}>{body}</AssistantFrame>
})

// Citações como "[slides.pdf, Pág. 33]" ou "[1, Pág. 33]" passam a etiquetas.
const CITE_RE = /\[([^[\]\n]{1,160}?,\s*(?:Pág\.|Slide)\s*[^[\]\n]{1,40})\](?!\()/g

// Resposta inteira embrulhada num bloco de código Markdown (```markdown … ```), mesmo a meio do streaming.
const OUTER_FENCE_RE = /^\s*```(?:markdown|md)?[ \t]*\n([\s\S]*?)(?:\n?```\s*)?$/

/** Texto para copiar: sem as referências às páginas/slides ("[ml.pdf, Pág. 3]") nem o bloco ```markdown à volta. */
function copyText(text) {
  const fenced = text.match(OUTER_FENCE_RE)
  return (fenced ? fenced[1] : text)
    .replace(new RegExp(`[ \\t]*${CITE_RE.source}`, 'g'), '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim()
}

function Markdown({ text, streaming, sources }) {
  const source = useMemo(() => {
    const fenced = text.match(OUTER_FENCE_RE)
    const body = fenced ? fenced[1] : text
    return body.replace(CITE_RE, (_, inner) => {
      // O modelo às vezes cita pelo número do bloco no contexto ("[1, Pág. 34]"); os blocos vão
      // pela mesma ordem das fontes. Se já escreveu o ficheiro ("[1, a.pdf, Pág. 2]"), basta tirar o número.
      const m = inner.match(/^(\d+),\s*(.+)$/)
      if (!m) return `[${inner}](#cite)`
      if (/\.(pdf|pptx)\b/i.test(m[2])) return `[${m[2]}](#cite)`
      const src = sources?.[Number(m[1]) - 1]
      return `[${src ? `${src.source}, ${m[2]}` : inner}](#cite)`
    })
  }, [text, sources])
  return (
    <div className={`md ${streaming ? 'caret' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href === '#cite' ? (
              <span className="mx-0.5 inline-flex items-center whitespace-nowrap rounded-md bg-surface-2 px-1.5 py-0.5 align-baseline font-mono text-[0.72em] text-muted">
                {children}
              </span>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

/** O menu de temas que o backend devolve a "faz um resumo", com escolha por cliques. */
function TopicMenu({ content, interactive, onChoose }) {
  const items = useMemo(() => {
    const out = []
    for (const line of content.split('\n')) {
      const m = line.match(/^(\d+)\.\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/)
      if (m) out.push({ n: Number(m[1]), title: m[2], where: m[3] })
    }
    // Com um só ficheiro, basta a página; com vários, mostra também o nome.
    const oneFile = new Set(out.map((it) => it.where?.split(', ')[0])).size <= 1
    return out.map((it) => ({ ...it, where: oneFile ? it.where?.split(', ').slice(1).join(', ') : it.where }))
  }, [content])
  const [picked, setPicked] = useState(() => new Set())

  function toggle(n) {
    setPicked((s) => {
      const x = new Set(s)
      x.has(n) ? x.delete(n) : x.add(n)
      return x
    })
  }

  function submit() {
    const nums = [...picked].sort((a, b) => a - b)
    const text = nums.length === 1 ? String(nums[0]) : `${nums.slice(0, -1).join(', ')} e ${nums.at(-1)}`
    onChoose(text)
  }

  return (
    <div>
      <p className="font-medium">{TOPIC_MENU_INTRO}</p>
      <p className="mt-0.5 text-sm text-muted">
        {interactive ? 'Escolhe um ou mais temas para um resumo desenvolvido.' : 'Os documentos abordam:'}
      </p>
      <ul className="mt-3 grid gap-1 sm:grid-cols-2">
        {items.map((it) => {
          const on = picked.has(it.n)
          return (
            <li key={it.n}>
              <label
                className={`flex h-full items-start gap-2.5 rounded-ui-sm border px-2.5 py-2 text-sm transition-colors ${
                  interactive ? 'cursor-pointer' : 'cursor-default'
                } ${on ? 'border-accent/60 bg-accent/10' : 'border-line hover:bg-surface-2/70'}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                  checked={on}
                  disabled={!interactive}
                  onChange={() => toggle(it.n)}
                />
                <span className="min-w-0">
                  <span className="block leading-snug">{it.title}</span>
                  {it.where && <span className="block text-xs text-muted">{it.where}</span>}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      {interactive && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={!picked.size} onClick={submit}>
            <Sparkles className="h-4 w-4" />
            {picked.size ? `Resumir ${picked.size} ${picked.size === 1 ? 'tema' : 'temas'}` : 'Escolhe temas'}
          </button>
          <button className="btn-outline" onClick={() => onChoose('tudo')}>
            Resumo geral
          </button>
        </div>
      )}
    </div>
  )
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false)
  if (!navigator.clipboard) return null
  return (
    <button
      className="focus-ring inline-flex items-center gap-1 rounded-ui-sm px-1 py-0.5 hover:text-fg"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
      aria-label="Copiar resposta"
    >
      {done ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copiado' : 'Copiar'}
    </button>
  )
}

const MAX_CHARS = 2000

function Composer({ disabled, canSend = true, centered, streaming, sendWith, onSend, onStop, placeholder, attach }) {
  const [text, setText] = useState('')
  const ta = useRef(null)

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  function submit() {
    if (!text.trim() || streaming || text.length > MAX_CHARS) return
    if (!canSend) return onSend(text) // mostra o aviso; o texto fica por enviar
    onSend(text)
    setText('')
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    const mod = e.ctrlKey || e.metaKey
    if (sendWith === 'ctrl_enter' ? mod : !e.shiftKey && !mod) {
      e.preventDefault()
      submit()
    }
  }

  const over = text.length > MAX_CHARS
  return (
    <div
      className={centered ? 'relative z-10' : 'relative z-10 shrink-0 px-4 pb-4 pt-2'}
      style={centered ? undefined : { paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto w-full max-w-chat">
        <div className="flex items-end gap-2 rounded-ui-lg border border-line bg-surface p-2 transition-colors focus-within:border-muted/60">
          <div className="shrink-0">{attach}</div>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            className="block max-h-[220px] min-h-[2.25rem] min-w-0 flex-1 resize-none bg-transparent px-1 py-[0.4rem] text-sm text-fg outline-none placeholder:text-muted"
            aria-label="Pergunta"
          />
          {text.length > MAX_CHARS * 0.8 && (
            <span className={`self-center text-xs ${over ? 'font-medium text-danger' : 'text-muted'}`}>
              {text.length}/{MAX_CHARS}
            </span>
          )}
          {streaming ? (
            <button
              className="focus-ring inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-ui-sm bg-fg text-bg transition hover:opacity-85"
              onClick={onStop}
              aria-label="Parar resposta"
              title="Parar"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              className="focus-ring inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-ui-sm bg-accent text-accent-fg transition hover:bg-accent/90 disabled:opacity-40"
              onClick={submit}
              disabled={disabled || !text.trim() || over || !canSend}
              aria-label="Enviar"
              title={canSend ? undefined : 'Anexa um ficheiro ou associa uma base de dados'}
            >
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className={`mt-1.5 hidden text-center text-[0.7rem] text-muted ${centered ? '' : 'sm:block'}`}>
          {sendWith === 'ctrl_enter' ? 'Ctrl+Enter para enviar' : 'Enter para enviar · Shift+Enter para nova linha'}
          {' · arrasta ficheiros para aqui para os juntar'}
        </p>
      </div>
    </div>
  )
}
