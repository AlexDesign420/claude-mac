import { useEffect } from 'react'

import { runtimeClient } from '@/lib/runtime-client'
import { tauriInvoke } from '@/lib/tauri'
import { useAppStore } from '@/store/app-store'
import type { RuntimeInfo } from '@/types/domain'

export function useRuntime() {
  const applyEnvelope = useAppStore((state) => state.applyEnvelope)
  const setRuntime = useAppStore((state) => state.setRuntime)
  const setConnectionStatus = useAppStore((state) => state.setConnectionStatus)

  useEffect(() => {
    let teardown = () => {}
    let statusTeardown = () => {}

    async function boot() {
      try {
        const runtime = await tauriInvoke<RuntimeInfo>('ensure_sidecar')
        setRuntime(runtime)
        statusTeardown = runtimeClient.onStatus(setConnectionStatus)
        runtimeClient.connect(runtime)
        teardown = runtimeClient.onMessage(applyEnvelope)
      } catch (error) {
        setConnectionStatus('error')
        applyEnvelope({
          type: 'error',
          payload: {
            message: 'Sidecar konnte nicht gestartet werden.',
            details: error instanceof Error ? error.message : String(error),
            suggestion: 'Oeffne die Diagnose: Dort stehen Bootstrap-Events, getestete Resource-Pfade, stderr/stdout und native Modul-Stacks. Danach npm run sidecar:prepare oder npm run sidecar:rebuild-native ausfuehren.',
          },
        })
      }
    }

    void boot()

    return () => {
      teardown()
      statusTeardown()
    }
  }, [applyEnvelope, setConnectionStatus, setRuntime])
}
