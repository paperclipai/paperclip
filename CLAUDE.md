# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Paperclip is an open-source orchestration platform for AI-agent companies.

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript
- **API**: Express.js REST API
- **UI**: React + Vite
- **Database**: PostgreSQL via Drizzle ORM
- **Package Manager**: pnpm (workspace monorepo)

## Quick Start

```bash
pnpm install
pnpm dev
```

## Repository Structure

- `server/` - Express REST API
- `ui/` - React + Vite board UI
- `packages/` - Shared packages (db, shared, adapters)
