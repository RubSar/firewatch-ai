import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import App from './App.tsx'

const HistoryPage = lazy(() => import('./history/HistoryPage.tsx'))
const isHistory = window.location.pathname.replace(/\/$/, '') === '/history'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isHistory ? <Suspense fallback={<p style={{ padding: 32 }}>Loading historical atlas…</p>}><HistoryPage /></Suspense> : <App />}
  </StrictMode>
)
