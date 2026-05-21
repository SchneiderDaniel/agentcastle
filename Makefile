# Makefile for AgentCastle first-time setup (DEPRECATED)
# Use Docker instead: ./agent-castle.sh
# Legacy scripts preserved at scripts/legacy/install.sh
# See: https://tech.davis-hansson.com/p/make/

SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

.PHONY: install
install:
	@echo "The host-level install is deprecated."
	@echo "Use Docker instead: ./agent-castle.sh"
	@echo "Legacy scripts preserved at scripts/legacy/install.sh"
