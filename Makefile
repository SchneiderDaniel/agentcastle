# Makefile for AgentCastle first-time setup
# Thin entry point — delegates all logic to scripts/install.sh
# See: https://tech.davis-hansson.com/p/make/

SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

.PHONY: install
install:
	bash scripts/install.sh
