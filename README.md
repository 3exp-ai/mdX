# mdX

A lightweight, split-screen Markdown editor built with [Tauri 2](https://tauri.app/) + [CodeMirror 6](https://codemirror.net/).

![mdX Screenshot](https://raw.githubusercontent.com/3exp-ai/mdX/main/screenshot.png)

## Features

- **Split-screen editing** — Left pane: pure text input with CodeMirror 6. Right pane: live HTML preview rendered by Rust.
- **Rust-driven preview** — All Markdown parsing happens in Rust via [pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark). Zero frontend parsing overhead.
- **Real-time sync** — 200ms debounced IPC + bidirectional scroll synchronization between editor and preview.
- **Local-first** — Reads and writes `.md` / `.markdown` / `.mdown` files directly on disk. No cloud, no account, no network required.
- **Auto-save** — 800ms debounce after any edit. Ctrl+S / Cmd+S for manual save.
- **File association** — Double-click any Markdown file to open it in mdX (via CLI argument passing).
- **Dark mode** — Deep dark theme with macOS-style overlay titlebar.
- **Fast startup** — ~65ms from HTML parse to editor ready. Total cold launch <500ms on warm starts.

## Architecture

```
┌─────────────────────────────────────────┐
│              mdX Window                 │
│  ┌─────────────┐  │  ┌─────────────┐   │
│  │  Editor     │  │  │   Preview   │   │
│  │  (CM6)      │◄─┘  │   (HTML)    │   │
│  │             │     │             │   │
│  └─────────────┘     └─────────────┘   │
│       │                    ▲           │
│       │ 200ms debounce     │           │
│       ▼                    │           │
│  ┌──────────────────────────────┐      │
│  │      Rust (Tauri 2)          │      │
│  │  pulldown-cmark → HTML       │      │
│  └──────────────────────────────┘      │
└─────────────────────────────────────────┘
```

**Design principle: Fat Rust, Thin UI**
- Frontend captures input, sends full text to Rust
- Rust parses Markdown → HTML via zero-copy iterator
- Frontend injects HTML directly (`innerHTML`)
- No Virtual DOM, no diff, no frontend Markdown parser

## Performance

| Metric | Value |
|--------|-------|
| Binary size | 12 MB (Release) |
| Frontend bundle | 270 KB (minified) |
| Source code | ~977 lines total |
| Markdown parse | <5ms per 100K chars |
| IPC round-trip | ~2-5ms (local) |
| Startup (editor ready) | ~65ms |
| Full cold launch | <500ms |

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (stable, 1.95+)
- [Node.js](https://nodejs.org/) (for esbuild bundling)

### Build

```bash
# 1. Install frontend dependencies (first time only)
cd public
npm install

# 2. Bundle the frontend
npx esbuild app.js --bundle --format=iife --minify --outfile=app.bundle.js

# 3. Build the release binary
cd ../src-tauri
cargo build --release
```

The executable is at `src-tauri/target/release/mdx` (macOS/Linux) or `mdx.exe` (Windows).

> **Note:** The `custom-protocol` feature is enabled so `cargo build --release` loads embedded assets correctly. If you use `cargo tauri build` instead, the CLI handles this automatically.

### Development mode

```bash
# Terminal 1: serve frontend
cd public
npx serve -l 8080 .

# Terminal 2: run Tauri dev
cd src-tauri
cargo tauri dev
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+S / Cmd+S | Save current file |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 (Rust) |
| Editor engine | CodeMirror 6 |
| Markdown parser | pulldown-cmark (Rust) |
| Frontend | Vanilla JS (zero framework) |
| Bundler | esbuild |
| Styling | Pure CSS |

### Dependencies

**Rust** (`Cargo.toml`)
- `tauri` 2.x — Desktop framework
- `serde` / `serde_json` — Serialization
- `pulldown-cmark` 0.13 — Markdown parser

**Frontend** (`package.json`)
- `@codemirror/view` 6.42 — Editor view
- `@codemirror/state` 6.6 — State management
- `@codemirror/commands` 6.10 — Keymaps & history
- `@lezer/markdown` 1.6 — Markdown syntax tree

All dependencies are vendored locally in `public/node_modules/` — zero network required at runtime.

## File Structure

```
mdX/
├── public/                    # Frontend assets
│   ├── index.html             # Shell HTML
│   ├── style.css              # Theme + preview styles
│   ├── app.js                 # Editor logic (~346 lines)
│   ├── app.bundle.js          # Bundled output (generated)
│   ├── node_modules/          # Local npm dependencies
│   └── package.json
├── src-tauri/                 # Rust backend
│   ├── src/
│   │   ├── main.rs            # Entry point
│   │   └── lib.rs             # IPC commands (~259 lines)
│   ├── Cargo.toml
│   └── tauri.conf.json
└── README.md
```

## License

[MIT](LICENSE)
