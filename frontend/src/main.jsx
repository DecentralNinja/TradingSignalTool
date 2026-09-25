import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.scss'
import App from './App.jsx'
import { TradePage } from './pages/TradePage.jsx'

const isTradeRoute = window.location.pathname.startsWith('/trade')

createRoot(document.getElementById('root')).render(
  <StrictMode>{isTradeRoute ? <TradePage /> : <App />}</StrictMode>,
)
