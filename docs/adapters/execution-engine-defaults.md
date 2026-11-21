# Installation-wide adapter execution engine defaults

On adapters that support both ACP and CLI, configure the default execution engine in the Paperclip **server** environment:

```bash
PAPERCLIP_DEFAULT_EXECUTION_ENGINES='{"claude_local":"cli","codex_local":"acp"}'
```

Supported adapter keys: `claude_local`, `codex_local`, `gemini_local`, and `kimi_local`. Each accepts `"acp"` or `"cli"`.

When the variable is unset, all listed adapters retain their existing ACP default. Explicit agent `engine` values always take precedence. Both new agents and existing agents with unset or `auto` engines resolve the installation default dynamically; stored agent configurations are not rewritten.

Invalid JSON, unknown adapter names, and unsupported engine values are rejected instead of silently ignored. Configure this on the Paperclip server process, and restart the server after changing the setting.

This controls only execution-engine selection. It does not bypass agent permissions, sandbox restrictions, runner-managed configuration, or model/version compatibility checks. There is no automatic fallback from ACP to CLI on an ACP failure.

See [issue #22459](https://github.com/paperclipai/paperclip/issues/22459).
