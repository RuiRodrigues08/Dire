import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { DEFAULTS, applySettings, cacheSettings, pickSettings, rememberLoginLook } from '../theme'

const SettingsContext = createContext(null)

/**
 * Definições do perfil (GET /api/settings). As alterações aplicam-se em direto
 * (`update`) e só vão para o servidor com `save` (ao fechar a janela ou em "Guardar").
 */
export function ThemeProvider({ profile, children }) {
  const [settings, setSettings] = useState(DEFAULTS)
  const [saved, setSaved] = useState(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const current = useRef(settings)
  current.current = settings

  useEffect(() => {
    let alive = true
    api
      .settings()
      .then((s) => {
        if (!alive) return
        const clean = pickSettings(s)
        setSettings(clean)
        setSaved(clean)
        cacheSettings(clean)
        rememberLoginLook({ profile, accent: clean.accent, loginBg: clean.login_background })
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    applySettings(settings)
    if (settings.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applySettings(current.current)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings])

  const update = useCallback((patch) => setSettings((s) => ({ ...s, ...patch })), [])

  const save = useCallback(async () => {
    const data = pickSettings(current.current)
    const res = await api.saveSettings(data)
    const clean = pickSettings(res)
    setSaved(clean)
    setSettings(clean)
    cacheSettings(clean)
    rememberLoginLook({ profile, accent: clean.accent, loginBg: clean.login_background })
    return clean
  }, [profile])

  const revert = useCallback(() => setSettings(saved), [saved])

  const dirty = useMemo(
    () => Object.keys(DEFAULTS).some((k) => settings[k] !== saved[k]),
    [settings, saved],
  )

  const value = useMemo(
    () => ({ settings, loaded, update, save, revert, dirty }),
    [settings, loaded, update, save, revert, dirty],
  )
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  return useContext(SettingsContext)
}
