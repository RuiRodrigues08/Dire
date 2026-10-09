import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { backgroundLayers } from '../backgrounds'
import { DEFAULTS, applySettings, hexToRgb, loginLook, rememberLoginLook } from '../theme'
import EncriptacaoVerify from './auth/EncriptacaoVerify'
import LoveVerify from './auth/LoveVerify'
import { systemTheme } from './auth/otpShared'

// Perfil que vê o ecrã "Decrypter"; todos os outros veem o do coração.
const ADMIN_PROFILE = 'admin'

const variantOf = (profile) => (profile && profile !== ADMIN_PROFILE ? 'love' : 'crypt')

/*
  O perfil só se sabe depois do login. Começa-se no ecrã (e na cor de destaque) do
  último perfil que entrou neste dispositivo; o pedido sai no fim do 4.º dígito e,
  se o código for do outro perfil, troca-se de ecrã, que arranca logo na animação
  com o mesmo código.
*/
export default function LoginScreen({ onLogin, notice }) {
  const [look] = useState(loginLook) // { profile, accent } ou null
  const [variant, setVariant] = useState(() => variantOf(look?.profile)) // 'crypt' | 'love'
  const [handoffCode, setHandoffCode] = useState(null)
  const [theme, setTheme] = useState(systemTheme)
  const [greeting, setGreeting] = useState(null)
  const sessionRef = useRef(null)

  // O ecrã de login usa sempre o tema do sistema (ainda não se sabe o perfil).
  useEffect(() => applySettings(DEFAULTS), [])

  async function submit(code, own) {
    const s = await api.login(code)
    sessionRef.current = s
    setGreeting(s.display_name)
    rememberLoginLook({ profile: s.profile })
    const next = variantOf(s.profile)
    if (next === own) return true
    setHandoffCode(code)
    setVariant(next)
    return false
  }

  // Fundo escolhido nas definições do último perfil que entrou neste dispositivo.
  const dark = theme === 'dark'
  const backdrop = backgroundLayers(look?.loginBg, {
    accent: hexToRgb(/^#[0-9a-f]{6}$/i.test(look?.accent || '') ? look.accent : DEFAULTS.accent).join(' '),
    ink: dark ? '255 255 255' : '0 0 0',
    bg: dark ? '13 10 14' : '239 236 239',
    image: look?.loginBgImage,
  })

  const props = {
    notice,
    theme,
    backdrop,
    accent: look?.accent,
    onToggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    greeting,
    onVerified: () => onLogin(sessionRef.current),
    initialCode: handoffCode,
  }

  return variant === 'crypt' ? (
    <EncriptacaoVerify key="crypt" {...props} submit={(c) => submit(c, 'crypt')} />
  ) : (
    <LoveVerify key="love" {...props} submit={(c) => submit(c, 'love')} />
  )
}
