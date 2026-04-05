# Qodo Local Adapter

Paperclip adapter that integrates [Qodo CLI](https://www.qodo.ai/) as a local agent backend.

## What it does

Runs Qodo CLI (`@qodo/command`) on the host machine as a Paperclip agent. Supports session persistence (`--resume`), CI-friendly non-interactive mode (`--ci --yes`), and Qodo's built-in tools (git, filesystem, shell, ripgrep, web search).

## Supported Models

Claude Sonnet/Opus 4.5–4.6, GPT-5.2–5.4, o4-mini, Gemini 2.5 Pro, Grok 4.

## Prerequisites

```bash
npm install -g @qodo/command
```

## Usage

Select `qodo_local` as the adapter type when creating a Paperclip agent. The adapter spawns Qodo CLI processes and bridges them to the Paperclip agent protocol.
