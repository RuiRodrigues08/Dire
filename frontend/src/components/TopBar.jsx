import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Database, LogOut, Moon, Settings, Share2, Sun } from 'lucide-react'

/*
  Ações do cabeçalho, à direita: partilha, base de dados da conversa, modo claro/escuro e o perfil
  (que abre as definições e o "Sair"). O título da página fica à esquerda (ChatWindow).
*/

const TITLE_CHARS = 48

/** Corta títulos compridos (o completo fica no `title` do elemento). */
export function shortTitle(text, max = TITLE_CHARS) {
  const t = (text || '').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function HeaderButton({ label, tooltip, active, onClick, children }) {
  return (
    <span className="group relative">
      <button
        onClick={onClick}
        aria-label={label}
        className={`focus-ring relative flex h-9 w-9 items-center justify-center rounded-ui border transition-colors ${
          active
            ? 'border-accent/50 bg-accent/10 text-accent hover:bg-accent/15'
            : 'border-line bg-surface text-fg/80 hover:bg-surface-2 hover:text-fg'
        }`}
      >
        {children}
      </button>
      {tooltip && (
        <span
          role="tooltip"
          className="pointer-events-none absolute right-0 top-full z-50 mt-2 max-w-[16rem] whitespace-nowrap rounded-ui-sm border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-fg opacity-0 shadow-lg transition-opacity delay-150 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {tooltip}
        </span>
      )}
    </span>
  )
}

export default function HeaderActions({
  session, avatar, dark, onToggleDark, library, onOpenLibraries, onOpenShare, onOpenSettings, onLogout,
}) {
  const [menu, setMenu] = useState(false)
  const box = useRef(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (e) => !box.current?.contains(e.target) && setMenu(false)
    const onKey = (e) => e.key === 'Escape' && setMenu(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const name = (session.display_name || session.profile || '?').trim()
  const initials = name.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('')

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {onOpenShare && (
        <HeaderButton label="Partilhar" tooltip="Partilhar por link" onClick={onOpenShare}>
          <Share2 className="h-3.5 w-3.5" />
        </HeaderButton>
      )}
      <HeaderButton
        label={library ? `Base de dados: ${library.name}` : 'Bases de dados'}
        tooltip={library ? <>Base de dados: <span className="font-semibold">{library.name}</span></> : 'Bases de dados'}
        active={!!library}
        onClick={onOpenLibraries}
      >
        <Database className="h-3.5 w-3.5" />
        {library && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />}
      </HeaderButton>

      <HeaderButton label={dark ? 'Mudar para modo claro' : 'Mudar para modo escuro'} tooltip={dark ? 'Modo claro' : 'Modo escuro'} onClick={onToggleDark}>
        {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
      </HeaderButton>

      <div ref={box} className="relative ml-3 sm:ml-4">
        {/* Sem caixa: a foto tem o tamanho e os cantos dos botões do cabeçalho (a foto é maior: 44px), com borda na cor de destaque. */}
        <button
          onClick={() => setMenu((m) => !m)}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label="Perfil"
          className="focus-ring group flex h-11 items-center gap-2.5 rounded-ui-sm text-fg/90 transition-colors hover:text-fg"
        >
          {avatar ? (
            <img src={avatar} alt="" className="h-11 w-11 shrink-0 rounded-ui border-2 border-accent object-cover transition-opacity group-hover:opacity-90" />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-ui border-2 border-accent bg-accent/15 text-sm font-bold text-accent">
              {initials}
            </span>
          )}
          <span className="hidden min-w-0 max-w-[10rem] text-left leading-tight sm:block">
            <span className="block truncate text-sm font-semibold">{session.display_name}</span>
            {session.remote && <span className="block truncate text-[0.7rem] text-muted">Acesso por link</span>}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition-transform group-hover:text-fg ${menu ? 'rotate-180' : ''}`} />
        </button>
        {menu && (
          <div role="menu" className="card animate-in absolute right-0 top-full z-50 mt-2 w-48 p-1 shadow-xl">
            <button
              role="menuitem"
              className="focus-ring flex w-full items-center gap-2.5 rounded-ui-sm px-3 py-2 text-left text-sm hover:bg-surface-2"
              onClick={() => {
                setMenu(false)
                onOpenSettings()
              }}
            >
              <Settings className="h-4 w-4 text-muted" /> Definições
            </button>
            <button
              role="menuitem"
              className="focus-ring flex w-full items-center gap-2.5 rounded-ui-sm px-3 py-2 text-left text-sm text-danger hover:bg-danger/10"
              onClick={() => {
                setMenu(false)
                onLogout()
              }}
            >
              <LogOut className="h-4 w-4" /> Sair
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
