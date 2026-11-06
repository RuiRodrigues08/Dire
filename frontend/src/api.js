// Cliente da API pública. Tudo na mesma origem, com o cookie de sessão.

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message)
    this.status = status
    this.data = data
  }
}

const BACKEND_DOWN = 'Servidor indisponível. Tenta novamente daqui a pouco.'

function errorMessage(status, data) {
  const d = data?.detail ?? data?.message
  if (typeof d === 'string') return d
  // Sem corpo JSON num 5xx: quem respondeu foi o proxy do Vite (npm run dev), não o backend.
  if (data == null && status >= 500) return BACKEND_DOWN
  if (Array.isArray(d)) return 'Pedido inválido.'
  if (status === 413) return 'O ficheiro é demasiado grande.'
  if (status >= 500) return 'Erro no servidor. Tenta de novo.'
  return `Erro ${status}`
}

async function request(method, path, body, { authEvent = true } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let r
  try {
    r = await fetch(path, init)
  } catch {
    throw new ApiError(0, BACKEND_DOWN)
  }
  if (!r.ok) {
    let data = null
    try {
      data = await r.json()
    } catch {
      /* corpo vazio */
    }
    if (r.status === 401 && authEvent) window.dispatchEvent(new Event('rag:unauthorized'))
    throw new ApiError(r.status, errorMessage(r.status, data), data)
  }
  const ct = r.headers.get('content-type') || ''
  return ct.includes('application/json') ? r.json() : r
}

export const api = {
  session: () => request('GET', '/api/session', undefined, { authEvent: false }),
  login: (code) => request('POST', '/api/auth/login', { code }, { authEvent: false }),
  logout: () => request('POST', '/api/auth/logout', undefined, { authEvent: false }),

  conversations: () => request('GET', '/api/conversations'),
  createConversation: () => request('POST', '/api/conversations', {}),
  patchConversation: (id, patch) => request('PATCH', `/api/conversations/${id}`, patch),
  deleteConversation: (id) => request('DELETE', `/api/conversations/${id}`),
  deleteAllConversations: () => request('DELETE', '/api/conversations'),
  messages: (id) => request('GET', `/api/conversations/${id}/messages`),
  exportConversation: async (id, ids = null) => {
    const only = ids ? `?ids=${ids.join(',')}` : ''
    const r = await request('GET', `/api/conversations/${id}/export${only}`)
    return r.blob()
  },

  documents: (id) => request('GET', `/api/conversations/${id}/documents`),
  uploadDocument: (id, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('POST', `/api/conversations/${id}/documents`, fd)
  },
  deleteDocument: (id, docId) => request('DELETE', `/api/conversations/${id}/documents/${docId}`),

  libraries: () => request('GET', '/api/libraries'),
  createLibrary: (name) => request('POST', '/api/libraries', { name }),
  renameLibrary: (id, name) => request('PATCH', `/api/libraries/${id}`, { name }),
  deleteLibrary: (id) => request('DELETE', `/api/libraries/${id}`),
  libraryDocuments: (id) => request('GET', `/api/libraries/${id}/documents`),
  searchLibrary: (id, q) => request('GET', `/api/libraries/${id}/search?q=${encodeURIComponent(q)}`),
  uploadLibraryDocument: (id, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('POST', `/api/libraries/${id}/documents`, fd)
  },
  deleteLibraryDocument: (id, docId) => request('DELETE', `/api/libraries/${id}/documents/${docId}`),

  uploadMedia: (kind, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('PUT', `/api/profile/media/${kind}`, fd)
  },
  deleteMedia: (kind) => request('DELETE', `/api/profile/media/${kind}`),

  share: () => request('GET', '/api/share'),
  startShare: (body) => request('POST', '/api/share/start', body),
  extendShare: (minutes) => request('POST', '/api/share/extend', { minutes }),
  stopShare: () => request('POST', '/api/share/stop'),
  shareDevices: () => request('GET', '/api/share/devices'),
  deviceAction: (id, action) => request('POST', `/api/share/devices/${id}/${action}`), // approve | block | disconnect
  forgetDevice: (id) => request('DELETE', `/api/share/devices/${id}`),
  setDeviceApproval: (required) => request('PUT', '/api/share/devices/approval', { required }),

  settings: () => request('GET', '/api/settings'),
  saveSettings: (data) => request('PUT', '/api/settings', data),
}

/**
 * Faz um POST e devolve os eventos NDJSON à medida que chegam (queue, progress, rewrite,
 * token, sources, done, error). Usa fetch + ReadableStream: os Quick Tunnels do
 * Cloudflare não suportam SSE.
 */
export async function* streamNdjson(path, body, signal) {
  let r
  try {
    r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new ApiError(0, BACKEND_DOWN)
  }
  if (!r.ok) {
    let data = null
    try {
      data = await r.json()
    } catch {
      /* corpo vazio */
    }
    if (r.status === 401) window.dispatchEvent(new Event('rag:unauthorized'))
    throw new ApiError(r.status, errorMessage(r.status, data), data)
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) yield JSON.parse(line)
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer)
}

export const streamChat = (conversationId, query, docIds, signal) =>
  streamNdjson(`/api/conversations/${conversationId}/chat`, { query, doc_ids: docIds ?? null }, signal)

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
