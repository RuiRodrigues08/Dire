import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { backgroundLayers, fetchDataUrl, mediaUrl } from './backgrounds'
import { clearCachedSettings, loginLook, rememberLoginLook, resolveTheme } from './theme'
import CaseToolsDialog from './components/CaseToolsDialog'
import ChatWindow from './components/ChatWindow'
import ConversationList, { BrandButton } from './components/ConversationList'
import { FilePicker, useDocumentActions } from './components/DocumentTray'
import LibraryDialog from './components/LibraryDialog'
import LoginScreen from './components/LoginScreen'
import ShareDialog from './components/ShareDialog'
import SessionBanner from './components/SessionBanner'
import SettingsDialog from './components/SettingsDialog'
import { ThemeProvider, useSettings } from './components/ThemeProvider'
import HeaderActions from './components/TopBar'
import { Spinner, useConfirm, useToast } from './components/ui'

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = a verificar; null = sem sessão
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null))
  }, [])

  // Qualquer 401 (sessão expirada, link revogado) volta ao login.
  useEffect(() => {
    const onUnauthorized = () =>
      setSession((s) => {
        if (s) setNotice(s.remote ? 'O acesso por link terminou. Entra de novo.' : 'A sessão terminou. Entra de novo.')
        return null
      })
    window.addEventListener('rag:unauthorized', onUnauthorized)
    return () => window.removeEventListener('rag:unauthorized', onUnauthorized)
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      /* a sessão já pode ter expirado */
    }
    clearCachedSettings()
    setNotice(null)
    setSession(null)
  }, [])

  if (session === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }
  if (!session) {
    return (
      <LoginScreen
        notice={notice}
        onLogin={(s) => {
          setNotice(null)
          setSession(s)
        }}
      />
    )
  }
  return (
    <ThemeProvider key={session.profile} profile={session.profile}>
      <Workspace session={session} setSession={setSession} onLogout={logout} />
    </ThemeProvider>
  )
}

const isDesktop = () => window.matchMedia?.('(min-width: 1024px)').matches ?? true

function Workspace({ session, setSession, onLogout }) {
  const { settings, update, save } = useSettings()
  const toast = useToast()
  const confirm = useConfirm()

  const [conversations, setConversations] = useState([])
  const [convLoading, setConvLoading] = useState(true)
  // Ao entrar abre-se sempre o início (mensagem de boas-vindas), não a última conversa.
  const [activeId, setActiveId] = useState(null)
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const [documents, setDocuments] = useState([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [excluded, setExcluded] = useState(() => new Set())
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('rag.sidebarCollapsed') === '1'
    } catch {
      return false
    }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [librariesOpen, setLibrariesOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const media = session.media || {}
  const setMedia = useCallback((m) => setSession((s) => (s ? { ...s, media: m } : s)), [setSession])

  // O ecrã de entrada abre antes de haver sessão: guarda-se neste dispositivo uma cópia da imagem de fundo.
  useEffect(() => {
    if (settings.login_background !== 'image' || !media.login_bg) return
    if (loginLook()?.loginBgVersion === media.login_bg) return
    fetchDataUrl(mediaUrl('login_bg', media.login_bg))
      .then((img) => {
        if (img.length < 3_500_000) rememberLoginLook({ loginBgImage: img, loginBgVersion: media.login_bg })
      })
      .catch(() => {})
  }, [settings.login_background, media.login_bg])
  const [libraries, setLibraries] = useState([])
  const [toolKind, setToolKind] = useState(null) // 'model' | 'solve' | null (janela aberta)
  const [task, setTask] = useState(null) // ferramenta à espera de correr no chat
  const takeTask = useCallback(() => setTask(null), [])

  const active = conversations.find((c) => c.id === activeId) || null
  const activeLibrary = libraries.find((l) => l.id === active?.library_id) || null

  const refreshLibraries = useCallback(async () => {
    try {
      setLibraries(await api.libraries())
    } catch {
      /* o botão continua a abrir a janela, que mostra o erro */
    }
  }, [])
  useEffect(() => {
    refreshLibraries()
  }, [refreshLibraries])

  const dark = resolveTheme(settings.theme) === 'dark'
  const toggleDark = useCallback(() => {
    update({ theme: dark ? 'light' : 'dark' })
    // Guarda depois de o React aplicar a mudança (save lê as definições atuais).
    setTimeout(() => save().catch((e) => toast(e.message, 'error')), 0)
  }, [dark, update, save, toast])

  const refreshConversations = useCallback(async () => {
    try {
      const list = await api.conversations()
      setConversations(list)
      return list
    } catch (e) {
      toast(e.message, 'error')
      return null
    } finally {
      setConvLoading(false)
    }
  }, [toast])

  useEffect(() => {
    refreshConversations()
  }, [refreshConversations])

  // `cid`: a conversa a recarregar (os carregamentos guardam a sua); só mexe na lista se ainda for a aberta.
  const loadDocuments = useCallback(
    async (cid) => {
      const id = cid ?? activeRef.current
      if (!id) return
      try {
        const list = await api.documents(id)
        if (id === activeRef.current) setDocuments(list)
      } catch (e) {
        toast(e.message, 'error')
      }
    },
    [toast],
  )

  useEffect(() => {
    setDocuments([])
    setExcluded(new Set())
    if (!activeId) return
    setDocsLoading(true)
    loadDocuments().finally(() => setDocsLoading(false))
  }, [activeId, loadDocuments])

  /** A conversa aberta; no início cria uma (ao enviar a 1.ª pergunta, juntar ficheiros ou associar uma base). */
  const ensureConversation = useCallback(async () => {
    if (activeRef.current) return activeRef.current
    const c = await api.createConversation()
    setConversations((list) => [c, ...list])
    activeRef.current = c.id
    setActiveId(c.id)
    return c.id
  }, [])

  const [pendingQuery, setPendingQuery] = useState(null) // pergunta feita no início, à espera da conversa nova
  const takePendingQuery = useCallback(() => setPendingQuery(null), [])
  const startWith = useCallback(
    async (query) => {
      try {
        await ensureConversation()
        setPendingQuery(query)
      } catch (e) {
        toast(e.message, 'error')
      }
    },
    [ensureConversation, toast],
  )

  // Documentos da conversa: partilhados pela barra lateral e pelo chat.
  const fileInput = useRef(null)
  const [docsOpen, setDocsOpen] = useState(false)
  const docs = useDocumentActions({ conversationId: active?.id, onChanged: loadDocuments, setExcluded })
  const { addFiles: addDocs } = docs
  // Ao juntar ficheiros, o painel abre para se ver o progresso.
  const addFiles = useCallback(
    async (files) => {
      if (!files?.length) return
      try {
        const cid = await ensureConversation()
        setDocsOpen(true)
        return addDocs(files, cid)
      } catch (e) {
        toast(e.message, 'error')
      }
    },
    [addDocs, ensureConversation, toast],
  )
  const pickFiles = useCallback(() => fileInput.current?.click(), [])

  useEffect(() => {
    try {
      localStorage.setItem('rag.sidebarCollapsed', collapsed ? '1' : '0')
    } catch {
      /* sem localStorage */
    }
  }, [collapsed])

  function select(id) {
    setActiveId(id)
    setSidebarOpen(false)
  }

  // "Nova conversa" volta ao início; a conversa só é criada quando se usa.
  function newConversation() {
    select(null)
  }

  async function rename(id, title) {
    try {
      const c = await api.patchConversation(id, { title })
      setConversations((list) => list.map((x) => (x.id === id ? c : x)))
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  async function togglePin(conv) {
    try {
      await api.patchConversation(conv.id, { pinned: !conv.pinned })
      await refreshConversations()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  /** Associa (ou, com null, desassocia) uma base de dados à conversa aberta. */
  async function attachLibrary(libraryId) {
    try {
      const cid = await ensureConversation()
      const c = await api.patchConversation(cid, { library_id: libraryId })
      setConversations((list) => list.map((x) => (x.id === c.id ? c : x)))
      setExcluded(new Set())
      await Promise.all([loadDocuments(cid), refreshLibraries()])
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  async function remove(conv) {
    if (settings.confirm_delete) {
      const ok = await confirm({
        title: 'Apagar conversa?',
        message: `“${conv.title}” é apagada com os documentos e o histórico. Não dá para desfazer.`,
        confirmLabel: 'Apagar',
        danger: true,
      })
      if (!ok) return
    }
    try {
      await api.deleteConversation(conv.id)
      const list = await refreshConversations()
      if (conv.id === activeId) setActiveId(null)
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const onBudget = useCallback(
    (b) =>
      setSession((s) =>
        s && s.remote
          ? {
              ...s,
              questions_left: b.questions_left ?? s.questions_left,
              tokens_left: b.tokens_left ?? s.tokens_left,
            }
          : s,
      ),
    [setSession],
  )

  const onExpired = useCallback(() => window.dispatchEvent(new Event('rag:unauthorized')), [])

  return (
    <div className="relative flex h-full flex-col">
      <div
        className="aurora"
        aria-hidden="true"
        style={{
          background:
            backgroundLayers(settings.background, {
              accent: 'var(--accent)',
              ink: 'var(--text)',
              bg: 'var(--bg)',
              image: mediaUrl('chat_bg', media.chat_bg),
            }) || 'none',
        }}
      />
      {session.remote && <SessionBanner session={session} onExpired={onExpired} />}

      <div className="relative z-10 flex min-h-0 flex-1">
        {/* Barra lateral: moldura colorida com painel de vidro; a partir de lg recolhe por completo
            (fica só o logo e o título, no cabeçalho do chat). Gaveta em ecrãs pequenos. */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/30 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
        <div
          className={`fixed inset-y-0 left-0 z-40 w-64 max-w-[86vw] transition-[transform,width,visibility] duration-200 ease-out lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:overflow-hidden ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          } ${collapsed ? 'lg:invisible lg:w-0' : 'lg:w-64'}`}
        >
          <div className="h-full lg:w-64">
            <ConversationList
              conversations={conversations}
              activeId={activeId}
              loading={convLoading}
              onToggleCollapsed={() => setCollapsed(true)}
              onSelect={select}
              onNew={newConversation}
              onRename={rename}
              onTogglePin={togglePin}
              onDelete={remove}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>

        <ChatWindow
          conversation={active}
          documents={documents}
          docsLoading={docsLoading}
          excluded={excluded}
          docs={docs}
          addFiles={addFiles}
          pickFiles={pickFiles}
          docsOpen={docsOpen}
          setDocsOpen={setDocsOpen}
          onOpenTool={setToolKind}
          brand={
            <BrandButton
              collapsed={collapsed}
              onClick={() => (isDesktop() ? setCollapsed(false) : setSidebarOpen(true))}
            />
          }
          actions={
            <HeaderActions
              session={session}
              avatar={mediaUrl('avatar', media.avatar)}
              onOpenShare={session.is_admin && !session.remote ? () => setShareOpen(true) : null}
              dark={dark}
              onToggleDark={toggleDark}
              library={activeLibrary}
              onOpenLibraries={() => setLibrariesOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              onLogout={onLogout}
            />
          }
          onNewConversation={newConversation}
          userName={session.display_name}
          onStartWith={startWith}
          pendingQuery={pendingQuery}
          onPendingTaken={takePendingQuery}
          libraries={libraries}
          library={activeLibrary}
          onAttachLibrary={attachLibrary}
          onManageLibraries={() => setLibrariesOpen(true)}
          onActivity={refreshConversations}
          onBudget={onBudget}
          task={task}
          onTaskTaken={takeTask}
        />
      </div>

      <FilePicker inputRef={fileInput} onFiles={addFiles} />

      <CaseToolsDialog
        kind={toolKind}
        documents={documents}
        onClose={() => setToolKind(null)}
        onSubmit={({ kind, body, label }) => {
          const path = `/api/conversations/${activeId}/${kind === 'model' ? 'model-answer' : 'solve'}`
          setTask({ path, body, label })
          setToolKind(null)
        }}
      />

      <LibraryDialog
        open={librariesOpen}
        onClose={() => setLibrariesOpen(false)}
        conversation={active || { id: null, title: 'Nova conversa', library_id: null }}
        onAttach={attachLibrary}
        onOpenConversation={(id) => {
          setLibrariesOpen(false)
          select(id)
        }}
        onChanged={async () => {
          await refreshLibraries()
          // ficheiros da base associada mudaram: a conversa aberta vê-os logo
          if (active?.library_id) await loadDocuments()
          // apagar uma base desliga-a das conversas
          await refreshConversations()
        }}
      />

      {session.is_admin && !session.remote && <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        session={session}
        activeConversation={active}
        conversations={conversations}
        media={media}
        onMediaChanged={setMedia}
        onLogout={onLogout}
        onDeletedAll={async () => {
          setActiveId(null)
          await refreshConversations()
          setSettingsOpen(false)
        }}
      />
    </div>
  )
}
