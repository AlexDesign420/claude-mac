import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'

import App from './App.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <>
      <App />
      <Toaster
        position="top-right"
        toastOptions={{
          className:
            'border border-white/10 bg-slate-950/90 text-slate-100 shadow-2xl shadow-cyan-950/20',
        }}
      />
    </>
  </StrictMode>,
)
