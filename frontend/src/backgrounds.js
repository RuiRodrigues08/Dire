// Fundos das conversas e do ecrã de entrada. As cores entram como "R G B" (ou var(--x)) para
// poderem levar transparência; o mesmo desenho serve para os dois sítios.

export const CHAT_BACKGROUNDS = [
  { id: 'plain', label: 'Liso' },
  { id: 'gradient', label: 'Suave' },
  { id: 'mesh', label: 'Aurora' },
  { id: 'dots', label: 'Pontos' },
  { id: 'image', label: 'Imagem' },
]

export const LOGIN_BACKGROUNDS = [{ id: 'default', label: 'Padrão' }, ...CHAT_BACKGROUNDS.slice(1)]

/**
 * Valor para a propriedade CSS `background` (sem a cor de fundo final), ou null para liso.
 * `accent`, `ink` e `bg`: "R G B" ou "var(--x)". `image`: URL (ou data:) da imagem.
 */
export function backgroundLayers(kind, { accent, ink, bg, image }) {
  const a = (alpha) => `rgb(${accent} / ${alpha})`
  switch (kind) {
    case 'gradient':
      return `radial-gradient(60vw 50vh at 0% 0%, ${a(0.12)}, transparent 70%)`
    case 'mesh':
      return [
        `radial-gradient(55vw 50vh at 8% 0%, ${a(0.26)}, transparent 70%)`,
        `radial-gradient(50vw 45vh at 100% 100%, ${a(0.2)}, transparent 70%)`,
        `radial-gradient(40vw 40vh at 85% 8%, ${a(0.1)}, transparent 70%)`,
      ].join(', ')
    case 'dots':
      return `radial-gradient(rgb(${ink} / 0.13) 1px, transparent 1.4px) 0 0 / 22px 22px`
    case 'image':
      // véu da cor do tema por cima, para o texto continuar legível
      return image ? `linear-gradient(rgb(${bg} / 0.55), rgb(${bg} / 0.55)), url("${image}") center / cover no-repeat` : null
    default:
      return null
  }
}

export const mediaUrl = (kind, version) => (version ? `/api/profile/media/${kind}?v=${version}` : null)

/** Lê uma imagem como data: URL (para o ecrã de entrada, que abre antes de haver sessão). */
export async function fetchDataUrl(url) {
  const r = await fetch(url, { credentials: 'same-origin' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const blob = await r.blob()
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = reject
    fr.readAsDataURL(blob)
  })
}
