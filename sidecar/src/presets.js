export const MODE_ORDER = ['safe', 'auto', 'no_confirm', 'full_auto']

export const DEFAULT_MODE_PRESETS = [
  {
    mode: 'safe',
    label: 'Safe Mode',
    description: 'Standardmodus mit normalem Claude-Code-Verhalten und Rueckfragen.',
    startCommand: 'claudestart',
    startArgs: [],
    env: {},
    enabled: true,
  },
  {
    mode: 'auto',
    label: 'Auto Mode',
    description: 'Leicht autonomer Start ueber konfigurierbare Argumente oder Umgebungsvariablen.',
    startCommand: 'claudestart',
    startArgs: [],
    env: {},
    enabled: true,
  },
  {
    mode: 'no_confirm',
    label: 'No Confirm Mode',
    description: 'Minimiert Rueckfragen, ohne den bestehenden Workflow zu erzwingen.',
    startCommand: 'claudestart',
    startArgs: [],
    env: {},
    enabled: true,
  },
  {
    mode: 'full_auto',
    label: 'Full Auto Mode',
    description: 'Maximal autonomes Profil fuer lange Runs; Preset bleibt voll editierbar.',
    startCommand: 'claudestart',
    startArgs: [],
    env: {},
    enabled: true,
  },
]

export function sortModePresets(presets) {
  return presets.slice().sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode))
}
