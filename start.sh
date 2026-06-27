#!/bin/bash
# Start Agent Multiplexer services (backend + frontend)
# Usage: ~/agent-multiplexer/start.sh
#
# Backend:  port 3461  (WebSocket + PTY + Parakeet STT)
# Frontend: port 3460  (Vite dev server)

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

# Check if already running
if lsof -ti :3460,:3461 >/dev/null 2>&1; then
  echo "Agent Multiplexer is already running."
  echo "  Frontend: http://localhost:3460"
  echo "  Backend:  ws://localhost:3461"
  echo ""
  echo "Run ~/agent-multiplexer/stop.sh to stop it first."
  exit 0
fi

# Check node-pty spawn-helper permissions
SPAWN_HELPER="$DIR/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
if [ -f "$SPAWN_HELPER" ] && [ ! -x "$SPAWN_HELPER" ]; then
  echo "Fixing node-pty spawn-helper permissions..."
  chmod +x "$SPAWN_HELPER"
fi

# sherpa-onnx needs its native libraries on the library path
SHERPA_LIB="$DIR/node_modules/sherpa-onnx-darwin-arm64"
if [ -d "$SHERPA_LIB" ]; then
  export DYLD_LIBRARY_PATH="$SHERPA_LIB:${DYLD_LIBRARY_PATH:-}"
fi

echo "Starting Agent Multiplexer..."

# Start backend
npx tsx server/index.ts >/tmp/agent-mux-backend.log 2>&1 &
BACKEND_PID=$!
echo "  Backend  :3461 (PID $BACKEND_PID)"

# Wait for backend to be ready
for i in $(seq 1 15); do
  if lsof -ti :3461 >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! lsof -ti :3461 >/dev/null 2>&1; then
  echo "ERROR: Backend failed to start. Check /tmp/agent-mux-backend.log"
  tail -10 /tmp/agent-mux-backend.log
  exit 1
fi

# Start frontend
npx vite --port 3460 >/tmp/agent-mux-frontend.log 2>&1 &
FRONTEND_PID=$!
echo "  Frontend :3460 (PID $FRONTEND_PID)"

# Wait for frontend to be ready
for i in $(seq 1 10); do
  if lsof -ti :3460 >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo ""
echo "  Ready → http://localhost:3460"
echo ""
echo "Logs:  /tmp/agent-mux-backend.log"
echo "       /tmp/agent-mux-frontend.log"
echo ""
echo "Stop:  ~/agent-multiplexer/stop.sh"
