import { useEffect, useRef } from 'react'
import { AlertTriangle, Clock, Coins, MessageSquare } from 'lucide-react'
import { formatDuration, useNow, useToast } from './ui'

const WARN_SECONDS = 10 * 60

/** Faixa só para sessões remotas (link partilhado): tempo e orçamento restantes. */
export default function SessionBanner({ session, onExpired }) {
  const now = useNow(1000)
  const toast = useToast()
  const warned = useRef(false)
  const ends = Math.min(session.expires_at, session.share_expires_at ?? Infinity)
  const left = ends - now / 1000

  useEffect(() => {
    if (left <= 0) onExpired()
    else if (left <= WARN_SECONDS && !warned.current) {
      warned.current = true
      toast('O link de partilha termina daqui a menos de 10 minutos.', 'info', 8000)
    }
  }, [left, onExpired, toast])

  const warn = left <= WARN_SECONDS
  return (
    <div
      className={`flex flex-wrap items-center justify-center gap-x-5 gap-y-1 border-b px-4 py-1.5 text-xs ${
        warn ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line bg-surface-2/60 text-muted'
      }`}
      role="status"
    >
      <span className="inline-flex items-center gap-1.5 font-medium">
        {warn ? <AlertTriangle className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
        Acesso por link · termina em {formatDuration(left)}
      </span>
      {session.questions_left != null && (
        <span className="inline-flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />
          {session.questions_left} perguntas restantes
        </span>
      )}
      {session.tokens_left != null && (
        <span className="inline-flex items-center gap-1.5">
          <Coins className="h-3.5 w-3.5" />
          {session.tokens_left.toLocaleString('pt-PT')} tokens restantes
        </span>
      )}
    </div>
  )
}
