import { FitAddon } from '@xterm/addon-fit'
import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'

import { runtimeClient } from '@/lib/runtime-client'
import type { RawLogRecord, RuntimeEnvelope } from '@/types/domain'

import 'xterm/css/xterm.css'

interface PtyTerminalProps {
  sessionId: string | null
  logs: RawLogRecord[]
}

export function PtyTerminal({ sessionId, logs }: PtyTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const seenLogIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!containerRef.current) {
      return
    }

    containerRef.current.innerHTML = ''
    seenLogIdsRef.current = new Set()

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: '#171412',
        foreground: '#fff7ed',
        cursor: '#f2b56b',
        selectionBackground: 'rgba(217,119,69,0.26)',
      },
      allowTransparency: true,
      convertEol: false,
      scrollback: 4000,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal

    if (sessionId) {
      runtimeClient.resizeSession(sessionId, terminal.cols, terminal.rows)
    } else {
      terminal.writeln('Keine Session ausgewaehlt.')
    }

    const dataDisposable = terminal.onData((data) => {
      if (!sessionId) {
        return
      }
      runtimeClient.sendTerminalInput(sessionId, data)
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      if (sessionId) {
        runtimeClient.resizeSession(sessionId, terminal.cols, terminal.rows)
      }
    })
    resizeObserver.observe(containerRef.current)

    const unsubscribe = runtimeClient.onMessage((envelope: RuntimeEnvelope) => {
      if (envelope.type !== 'pty_output') {
        return
      }

      const payload = envelope.payload as { sessionId: string; chunk: string }
      if (payload.sessionId !== sessionId) {
        return
      }

      terminal.write(payload.chunk)
    })

    terminal.focus()

    return () => {
      unsubscribe()
      resizeObserver.disconnect()
      dataDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !sessionId) {
      return
    }

    const outputLogs = logs
      .filter((log) => log.sessionId === sessionId && log.direction === 'output')
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    for (const log of outputLogs) {
      if (seenLogIdsRef.current.has(log.id)) {
        continue
      }

      seenLogIdsRef.current.add(log.id)
      terminal.write(log.chunk)
    }
  }, [logs, sessionId])

  return <div ref={containerRef} className="h-full min-h-[460px] w-full max-w-full overflow-hidden rounded-[22px]" />
}
