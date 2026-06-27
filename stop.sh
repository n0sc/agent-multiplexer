#!/bin/bash
# Stop Agent Multiplexer services (ports 3460 + 3461)
# Usage: ~/agent-multiplexer/stop.sh

PIDS=$(lsof -ti :3460,:3461 2>/dev/null)

if [ -z "$PIDS" ]; then
  echo "Agent Multiplexer is not running."
  exit 0
fi

echo "Stopping Agent Multiplexer (PIDs: $(echo $PIDS | tr '\n' ' '))"
kill $PIDS 2>/dev/null
sleep 1

# Force kill any survivors
REMAINING=$(lsof -ti :3460,:3461 2>/dev/null)
if [ -n "$REMAINING" ]; then
  echo "Force killing remaining processes..."
  kill -9 $REMAINING 2>/dev/null
fi

echo "Stopped."
