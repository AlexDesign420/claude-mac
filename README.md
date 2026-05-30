# Claude Mac App

A native macOS desktop application for [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), built with **Tauri 2**, **React**, **TypeScript** and **SQLite**.

Replaces the terminal as the primary Claude Code interface while keeping your existing `claudestart` and LM Studio workflows untouched.

---

## Features

- **Embedded PTY Terminal** — Run Claude Code directly inside the app
- **Persistent Projects & Sessions** — SQLite-backed project and session management
- **Chat & Log Views** — Dual-pane view from the same terminal stream
- **Agent Command Center** — Live team view, execution tree and tool timeline
- **Hook Integration** — Install, receive and store Claude Code hooks in SQLite
- **WebSocket Connection** — Auto-reconnect with visible connection state
- **Status & Usage Parsing** — Robust `/status` command handling
- **Bundled Sidecar** — Release builds include a bundled Node.js runtime

---

## Architecture

```
Tauri Desktop App
    └── React Frontend
          └── Bundled Sidecar (Node.js)
                └── node-pty
                      └── claudestart
                            └── LM Studio
```

**Key principle:** `claudestart` remains the engine. LM Studio remains unchanged. No API key required.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop Framework | Tauri 2 (Rust) |
| Frontend | React 19, TypeScript, Tailwind CSS |
| Terminal | node-pty |
| Database | SQLite (via better-sqlite3) |
| Build | Vite |
| Bundling | Custom sidecar with bundled Node.js runtime |

---

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (Tauri + Sidecar from repo)
npm run tauri:dev

# Build release with bundled sidecar
npm run tauri:build
```

---

## Project Status

Active development. Core features are functional:

- [x] PTY terminal embedding
- [x] Project / session persistence
- [x] Chat and log views
- [x] Hook reception and storage
- [x] Agent Command Center (live team, execution tree, tool timeline)
- [x] WebSocket with reconnect
- [x] Release builds with bundled Node runtime

---

## Privacy & Security

- This repository does not intentionally include private personal data.
- No API keys or credentials are required for the core workflow.
- LM Studio runs locally — no cloud LLM dependency.
- Sensitive user-specific paths have been removed from documentation.

---

## License

MIT — see [LICENSE](LICENSE).
