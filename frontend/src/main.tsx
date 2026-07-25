import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthSessionProvider } from './auth/AuthSessionContext'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthSessionProvider>
      <App />
    </AuthSessionProvider>
  </StrictMode>,
)
