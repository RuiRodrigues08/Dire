import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/theme.css'
import App from './App'
import { ConfirmProvider, ToastProvider } from './components/ui'
import { applySettings, cachedSettings } from './theme'

// Aplicar a cópia local do tema antes do primeiro desenho (evita piscar ao abrir).
applySettings(cachedSettings() || {})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </React.StrictMode>,
)
