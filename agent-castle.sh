#!/bin/bash
set -e

# ------------------------------------------------------------------
# AgentCastle — Docker Compose orchestration wrapper
#
# Single entry point to build, start, and enter the agentcastle
# container with workspace mounts and resource limits configured
# via the project's settings file.
#
# Usage:
#   ./agent-castle.sh
# ------------------------------------------------------------------

# --- Step 1: Assert docker is on PATH ---------------------------------
if ! command -v docker &>/dev/null; then
    echo "Error: Docker not found on PATH."
    echo "Install Docker from: https://docs.docker.com/get-docker/"
    echo ""
    echo "After installing, ensure your user is in the 'docker' group:"
    echo "  sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

# --- Step 2: Assert/ensure .agent_env exists --------------------------
if [ ! -f ".agent_env" ]; then
    echo "Warning: .agent_env not found."
    echo ""
    echo "Copy the example file and fill in your API tokens:"
    echo "  cp .agent_env.example .agent_env"
    echo "  nano .agent_env   # (or your editor of choice)"
    echo ""
    echo "Creating an empty .agent_env as fallback (compose will proceed without env vars)."
    touch .agent_env
fi

# --- Step 3: Read resource limits from .pi/settings.json --------------
if ! command -v jq &>/dev/null; then
    echo "Error: jq is required but not found on PATH."
    echo "Install from: https://jqlang.github.io/jq/download/"
    exit 1
fi

AGENTCASTLE_MEMORY=$(jq -r '.docker.memory // "4G"' .pi/settings.json)
AGENTCASTLE_CPUS=$(jq -r '.docker.cpus // "2.0"' .pi/settings.json)

export AGENTCASTLE_MEMORY
export AGENTCASTLE_CPUS

# --- Step 4: Export host identity -------------------------------------
export HOST_UID
HOST_UID=$(id -u)
export HOST_GID
HOST_GID=$(id -g)

# --- Step 5: Start (or rebuild) the container -------------------------
echo "Starting agentcastle container..."
docker compose up -d --build

# --- Step 6: Launch interactive pi session ----------------------------
echo "Entering pi agent inside container..."
docker exec -it agentcastle /bin/bash -c 'cd /workspaces/main && pi'
