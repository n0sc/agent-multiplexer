/**
 * TerminalPane — Renders a live terminal using xterm.js.
 *
 * Each terminal stays mounted for the lifetime of the session.
 * When not active, it's hidden via CSS (display:none) so that
 * scrollback and state are preserved when switching back and forth.
 *
 * Connects to the output store for the given session and pipes data
 * both ways: PTY output → terminal, terminal input → PTY.
 */

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { SessionMeta } from '../shared/protocol'
import { outputStore } from '../hooks/useAgentMux'

interface TerminalPaneProps {
  session: SessionMeta
  /** Whether this pane is the currently visible one */
  active: boolean
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
}

export function TerminalPane({ session, active, onInput, onResize }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // ── Init terminal (once per session — NOT re-created on switch) ──

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#c9d1d9',
        brightBlack: '#484f58',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4d4',
        brightWhite: '#f0f6fc',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Input → PTY
    term.onData(data => onInput(data))

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      onResize(term.cols, term.rows)
    })
    resizeObserver.observe(containerRef.current)

    // Initial size
    onResize(term.cols, term.rows)

    return () => {
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [session.id])

  // ── Subscribe to output store (for entire session lifetime) ─────

  useEffect(() => {
    const unsubscribe = outputStore.subscribe(session.id, (data) => {
      termRef.current?.write(data)
    })
    return unsubscribe
  }, [session.id])

  // ── Focus + refit when becoming active ──────────────────────────

  useEffect(() => {
    if (active) {
      // Refit in case the container was hidden when size changed
      setTimeout(() => {
        fitRef.current?.fit()
        termRef.current?.focus()
      }, 0)
    }
  }, [active])

  // ── Status indicator overlay ───────────────────────────────────

  const statusConfig = {
    idle:         { label: 'Idle',          color: '#6e7681', pulse: false },
    working:      { label: 'Working',       color: '#58a6ff', pulse: true  },
    'needs-input':{ label: 'Needs Input',   color: '#d29922', pulse: true  },
    completed:    { label: 'Completed',     color: '#3fb950', pulse: false },
    failed:       { label: 'Failed',        color: '#ff7b72', pulse: false },
    stopped:      { label: 'Stopped',       color: '#6e7681', pulse: false },
    detached:     { label: 'Detached',      color: '#6e7681', pulse: false },
  }

  const sc = statusConfig[session.status]

  return (
    <div className="terminal-pane" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-status-bar">
        <span
          className={`status-dot ${sc.pulse ? 'pulse' : ''}`}
          style={{ background: sc.color }}
        />
        <span className="status-label" style={{ color: sc.color }}>{sc.label}</span>
        <span className="session-name">{session.name}</span>
        <span className="session-meta">{session.agentType} · {session.cwd}</span>
      </div>
      <div ref={containerRef} className="xterm-container" />
    </div>
  )
}
