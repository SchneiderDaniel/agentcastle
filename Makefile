# Makefile for AgentCastle — Docker workflow (Linux)
# Targets: up (build+start), shell (enter container), pi (launch agent)
# See: https://tech.davis-hansson.com/p/make/

SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

.PHONY: up shell pi

# Build and start the AgentCastle container
up:
	@if ! command -v docker &>/dev/null; then \
		echo "Error: Docker not found on PATH."; \
		echo "Install Docker from: https://docs.docker.com/get-docker/"; \
		echo ""; \
		echo "After installing, ensure your user is in the 'docker' group:"; \
		echo "  sudo usermod -aG docker \$$USER && newgrp docker"; \
		exit 1; \
	fi
	@if ! command -v jq &>/dev/null; then \
		echo "Error: jq is required but not found on PATH."; \
		echo "Install from: https://jqlang.github.io/jq/download/"; \
		exit 1; \
	fi
	@if [ ! -f ".agent_env" ]; then \
		echo "Warning: .agent_env not found."; \
		echo ""; \
		echo "Copy the example file and fill in your API tokens:"; \
		echo "  cp docker/agent_env.example .agent_env"; \
		echo "  nano .agent_env   # (or your editor of choice)"; \
		echo ""; \
		echo "Creating an empty .agent_env as fallback (compose will proceed without env vars)."; \
		touch .agent_env; \
	fi
	@AGENTCASTLE_MEMORY=$$(jq -r '.docker.memory // "4G"' .pi/settings.json); \
	export AGENTCASTLE_MEMORY; \
	AGENTCASTLE_CPUS=$$(jq -r '.docker.cpus // "2.0"' .pi/settings.json); \
	export AGENTCASTLE_CPUS; \
	HOST_UID=$$(id -u); \
	export HOST_UID; \
	HOST_GID=$$(id -g); \
	export HOST_GID
	@echo "Starting agentcastle container..."
	docker compose -f docker/docker-compose.yml up -d --build

# Open a bash shell inside the running container
shell:
	@if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^agentcastle$$'; then \
		echo "Container agentcastle not running. Run 'make up' first."; \
		exit 1; \
	fi
	docker exec -it agentcastle /bin/bash

# Launch the pi agent inside the container (with splash loading screen)
pi:
	@if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^agentcastle$$'; then \
		echo "Container agentcastle not running. Run 'make up' first."; \
		exit 1; \
	fi
	# Use startup wrapper for splash integration during extension loading
	docker exec -it agentcastle /bin/bash -c 'cd /workspaces/main && node --experimental-strip-types src/start-pi.ts'
