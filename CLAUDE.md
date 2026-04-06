# Paperclip — Platform Development Context

This directory is the **Paperclip platform codebase**. Use this context for platform code changes, Docker config, and infrastructure work — not for company management or agent operations (use the board directory for that: `/Users/tomek/Obsidian_vault/Projects/paperclip/board/`).

## Quick Reference

- Docker: `docker compose -f docker-compose.quickstart.yml -f docker-compose.override.yml`
- Container: `paperclip-paperclip-1`
- UI: http://localhost:3100
- Agent workspace (mounted): `/Users/tomek/Obsidian_vault/Projects/paperclip/workspace/`

## Git Rules

- Never push directly to main — always PR + CI
- Never use while-true polling loops in agent code — use two-phase dispatch/collect

## Session Style

- Keep responses short and direct
- Lead with recommendations, not explanations
- When something is broken, diagnose before suggesting fixes
