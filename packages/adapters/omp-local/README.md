# @paperclipai/adapter-omp-local

OMP (PI + enhancements) local adapter for Paperclip.

## Overview

This adapter enables Paperclip to run OMP agents locally. OMP is built on PI (Pico Tools coding agent) with additional enhancements.

## Features

- Run OMP as a local child process
- Session resumption across heartbeats
- Support for multiple model providers via `--provider` and `--model` flags
- Thinking level configuration
- Skills injection support
- JSONL output parsing

## Installation

```bash
npm install @paperclipai/adapter-omp-local
```

## Configuration

```json
{
  "adapterType": "omp_local",
  "adapterConfig": {
    "command": "omp",
    "cwd": "/workspace/project",
    "model": "minimax/MiniMax-M2.7",
    "thinking": "medium",
    "timeoutSec": 900,
    "env": {
      "MINIMAX_API_KEY": "your-api-key"
    }
  }
}
```

## Adapter Options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | No | CLI command to run (default: "omp") |
| `cwd` | string | No | Working directory |
| `model` | string | Yes | Model in provider/model format |
| `thinking` | string | No | Thinking level (minimal, low, medium, high, xhigh) |
| `timeoutSec` | number | No | Run timeout in seconds (default: 900) |
| `graceSec` | number | No | SIGTERM grace period (default: 15) |
| `instructionsFilePath` | string | No | Path to instructions markdown file |
| `promptTemplate` | string | No | Custom prompt template |
| `env` | object | No | Environment variables |

## Session Management

Sessions are stored in `~/.omp/paperclips/` and can be resumed using the `--session` flag.

## Contributing

To build from source:

```bash
npm install
npm run build
```

## License

MIT
