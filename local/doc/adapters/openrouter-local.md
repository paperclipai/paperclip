# OpenRouter Local Adapter

The `openrouter_local` adapter executes tool-calling agents locally using models available via OpenRouter (or any OpenAI Chat Completions compatible API).

## Configuration

Required:
- `baseUrl`: The API base URL (defaults to OpenRouter, e.g. `https://openrouter.ai/api/v1`)
- `model`: The model slug (e.g. `anthropic/claude-3.5-sonnet`)

## Skills

Skill synchronization is fully supported by this adapter. When a company skill is assigned to an agent, its `SKILL.md` file is automatically read and injected as an instruction fragment into the system prompt prior to agent execution.

## Built-in Tools

- `read_file`
- `write_file`
- `list_directory`
- `run_command`
- `apply_patch`
