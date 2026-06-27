/**
 * Demo App — Shows the AgentMultiplexer component in action.
 *
 * Run: npm run dev (starts both Vite client + backend server)
 * Open: http://localhost:3460
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentMultiplexer } from '../src/index.tsx'

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <AgentMultiplexer
        serverUrl="ws://localhost:3461"
        height="100vh"
        showVoice={true}
        showSidebar={true}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <App />
)
