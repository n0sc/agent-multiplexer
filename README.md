# Agent Multiplexer

An embeddable React component for managing multiple AI agent sessions (Claude Code, Hermes, shells) from a single interface, with voice dictation powered by NVIDIA Parakeet TDT 0.6B v2.

## What it does

- **Session sidebar**: See all your agent sessions at a glance with live status indicators (working, needs input, idle, completed, failed)
- **Terminal pane**: Full xterm.js terminal for each session — scrollback persists when switching between sessions
- **Status detection**: Automatically detects when agents need input (regex pattern matching on prompt output) and alerts you
- **Voice dictation**: Click mic or hold Spacebar to record → NVIDIA Parakeet transcribes locally → review → send to terminal
- **Session persistence**: Sessions survive server restarts (state saved to `~/.agent-multiplexer/sessions.json`)
- **Archive**: Close button archives sessions instead of killing them — collapsible archived section with restore
- **Alert toasts**: Pop-up notifications when sessions need your attention
- **Embeddable**: Drop `<AgentMultiplexer />` into any React app

## Quick start

```bash
# Clone
git clone https://github.com/craigporter/agent-multiplexer.git
cd agent-multiplexer

# Install
npm install

# Fix node-pty permissions (macOS)
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper

# Download Parakeet model (~330MB compressed)
mkdir -p models && cd models
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
tar xf sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
cd ..

# Run (starts backend + frontend)
./start.sh

# Open http://localhost:3460
```

## Architecture

```
React Frontend (Vite, port 3460)
├── <AgentMultiplexer />     ← The embeddable component
│   ├── <SessionList />       ← Sidebar with status indicators + archive
│   ├── <TerminalPane />      ← xterm.js terminal (persistent scrollback)
│   └── <VoiceInput />        ← MediaRecorder → Whisper → review → send
│
WebSocket (ws://localhost:3461)
│
Node.js Backend (port 3461)
├── PTY Manager               ← Spawns and manages processes via node-pty
├── Status Detector           ← Pattern-matches output to detect state
├── Session Persistence       ← JSON state file for restart survival
└── Speech Manager            ← NVIDIA Parakeet TDT 0.6B v2 via sherpa-onnx
                                 (replaces OpenAI Whisper — faster + more accurate)
```

## Using the component

```tsx
import { AgentMultiplexer } from 'agent-multiplexer'

<AgentMultiplexer
  serverUrl="ws://localhost:3461"
  height="100vh"
/>
```

## Voice dictation

Uses NVIDIA Parakeet TDT 0.6B v2 (600M params, int8 quantized) running locally via sherpa-onnx:

1. **Click 🎙️** (or hold Spacebar) to start recording
2. **Click ⏹️** to stop
3. **Review** the transcription in the edit bar
4. **Click Send** (or press Enter) to send to the active terminal

Parakeet advantages over Whisper base.en:
- ~2× faster inference (RTF 0.03–0.12 vs ~0.5)
- ~2× more accurate (WER 6% vs 12%)
- Proper punctuation and casing
- Runs on CPU with int8 quantization

## Scripts

```bash
./start.sh    # Start backend + frontend
./stop.sh     # Stop all services
npm run dev   # Alternative: start both via concurrently
```

## Tech stack

- **Frontend**: React 18, xterm.js, Vite, TypeScript
- **Backend**: Node.js, ws (WebSocket), node-pty
- **STT**: NVIDIA Parakeet TDT 0.6B v2 via sherpa-onnx-node
- **Audio**: ffmpeg (WebM/Opus → 16kHz WAV)

## License

MIT
