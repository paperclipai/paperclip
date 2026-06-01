# Bob Shell Adapter for Paperclip

This adapter enables Paperclip agents to use **Bob Shell** as their execution runtime.

## Overview

The `bob_shell` adapter integrates Bob Shell into Paperclip's control plane by:

1. **Workspace Materialization** - Generates `.bob/` configuration before launching Bob Shell
2. **MCP Integration** - Connects Bob Shell back to Paperclip via the Paperclip MCP server
3. **Skill Projection** - Renders company skills as Bob Shell instruction files
4. **Lifecycle Management** - Handles Bob Shell process invocation, monitoring, and cancellation
5. **Prompt Caching** - Content-addressed prompt bundles for faster execution
6. **Error Handling** - Intelligent error classification and retry logic

## Architecture

```
Paperclip Agent (bob_shell)
    ↓
Prompt Bundle Cache (content-addressed)
    ↓
Workspace Sync (.bob/ generation)
    ↓
Bob Shell Process Launch
    ↓
Bob Shell ← MCP → Paperclip API
```

## Features

### ✅ Prompt Bundle Caching

The adapter uses content-addressed prompt bundles to avoid redundant workspace sync:

- **Content Hashing**: Bundles are keyed by hash of skills, instructions, and mode config
- **Cache Reuse**: Identical configurations reuse existing bundles
- **Fast Startup**: Cached bundles skip workspace sync entirely
- **Automatic Cleanup**: Old bundles can be cleaned up via cache management

### ✅ Error Classification & Retry Logic

Intelligent error handling with automatic retry:

- **Error Types**: Session, API, Config, Execution, Timeout, Unknown
- **Retry Strategy**: Exponential backoff for retryable errors
- **Session Recovery**: Automatic retry with fresh session on session errors
- **Detailed Logging**: Clear error messages with hints and context

**Configurable Options:**
- `maxRetries` (default: 2) - Maximum retry attempts
- `retryDelayMs` (default: 1000) - Base delay between retries (exponential backoff)

### ✅ Bootstrap Prompts

Support for bootstrap prompts on new sessions:

- **New Sessions Only**: Bootstrap prompt included only when starting fresh
- **Template Support**: Use `bootstrapPromptTemplate` config field
- **Metrics Tracking**: Separate metrics for bootstrap vs heartbeat prompts

### ✅ Progressive Status Updates

Real-time status updates during execution:

- **Incremental Parsing**: Parses stdout as it arrives
- **Rich Metadata**: Includes session ID, model, tokens, cost
- **Live Dashboard**: Updates visible on Paperclip board
- **Final Result**: Extracted from `<attempt_completion>` tags

## Generated Workspace Files

When a Bob Shell agent runs, Paperclip generates:

### `.bob/custom_modes.yaml`
Defines the `paperclip-agent` mode with:
- Role definition
- Custom instructions
- Tool groups (read, edit, command, browser, mcp)

### `.bob/mcp.json`
Configures the Paperclip MCP server connection with runtime environment variables:
- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_RUN_ID`

### `.bob/rules-paperclip-agent/*.md`
Instruction files including:
- `01-core.md` - Core Paperclip agent rules
- `02-repo.md` - Repository context guidance
- `03-tasking.md` - Task workflow rules
- `04+` - Company skill projections

## Configuration

### Agent Configuration Fields

```typescript
{
  command: string;           // Bob Shell executable (default: "bob")
  mode: string;              // Bob Shell mode (default: "paperclip-agent")
  cwd: string;               // Working directory
  model: string;             // AI model to use
  extraArgs: string[];       // Additional CLI arguments
  env: Record<string, EnvBinding>; // Environment variables
  timeoutSec: number;        // Run timeout (0 = no timeout)
  graceSec: number;          // SIGTERM grace period before SIGKILL
  promptTemplate: string;    // Heartbeat prompt template
  bootstrapPromptTemplate: string; // Bootstrap prompt for new sessions
  maxRetries: number;        // Maximum retry attempts (default: 2)
  retryDelayMs: number;      // Base retry delay in ms (default: 1000)
  modeConfig: object;        // Custom mode configuration
  instructionsFilePath: string; // Path to agent instructions file
}
```

### Example Agent Config

```json
{
  "adapterType": "bob_shell",
  "adapterConfig": {
    "command": "bob",
    "mode": "paperclip-agent",
    "cwd": "/path/to/workspace",
    "model": "claude-3-5-sonnet-20241022",
    "timeoutSec": 1800,
    "graceSec": 20,
    "maxRetries": 2,
    "retryDelayMs": 1000,
    "bootstrapPromptTemplate": "You are {{agent.name}}. Initialize your workspace and review the task.",
    "promptTemplate": "Continue working on your assigned task."
  }
}
```

## Error Handling

### Error Types

The adapter classifies errors into categories:

| Type | Code | Retryable | Description |
|------|------|-----------|-------------|
| `session` | `session_not_found`, `session_expired`, `session_corrupted` | ✅ Yes | Session-related errors |
| `api` | `api_rate_limit`, `api_timeout`, `api_server_error` | ✅ Yes | API errors (rate limits, timeouts, 5xx) |
| `config` | `auth_invalid`, `auth_required`, `config_invalid` | ❌ No | Configuration errors |
| `execution` | `tool_error`, `user_cancelled`, `execution_error`, `max_turns` | ❌ No | Execution failures |
| `timeout` | `timeout` | ❌ No | Process timeout |
| `unknown` | `unknown` | ❌ No | Unclassified errors |

### Retry Behavior

- **Retryable Errors**: Automatically retried with exponential backoff
- **Session Errors**: Retry with fresh session
- **API Errors**: Retry with same session after delay
- **Non-Retryable**: Fail immediately with detailed error message

### Example Error Messages

```
Session error - will retry with new session (session error) - retryable
Hint: Session may have expired or been deleted

API rate limit exceeded (api error) - retryable
Hint: Wait before retrying
Details: Error: Rate limit exceeded. Please try again in 60 seconds.

Authentication required (config error)
Hint: Check API key configuration
Details: Error: Invalid API key provided
```

## Prompt Bundle Caching

### How It Works

1. **Content Hashing**: Calculate hash of skills, instructions, mode config
2. **Bundle Key**: Generate unique key from content hash
3. **Cache Check**: Look for existing bundle in cache directory
4. **Cache Hit**: Reuse existing bundle (skip workspace sync)
5. **Cache Miss**: Create new bundle and sync workspace

### Cache Location

```
~/.paperclip/instances/{instance_id}/companies/{company_id}/bob-prompt-cache/{bundle_key}/
```

### Cache Benefits

- **Faster Startup**: Skip workspace sync on cache hit
- **Consistent Builds**: Same input always produces same bundle
- **Disk Efficiency**: Shared bundles across runs
- **Version Control Friendly**: Deterministic generation

### Cache Management

```bash
# View cache size
du -sh ~/.paperclip/instances/default/companies/*/bob-prompt-cache

# Clean old bundles (manual)
find ~/.paperclip/instances/default/companies/*/bob-prompt-cache \
  -type d -mtime +30 -exec rm -rf {} +
```

## Requirements

- Bob Shell must be installed and available in PATH or via configured command
- Paperclip MCP server must be accessible
- Valid Paperclip API credentials

## Workspace Sync Behavior

### Merge Semantics

Paperclip manages only its own entries:
- **Managed**: `paperclip-agent` mode, `paperclip` MCP server, `rules-paperclip-agent/` directory
- **Preserved**: User-defined modes, other MCP servers, unrelated `.bob/` files

### Deterministic Generation

Same input (skills + config) produces same `.bob/` output, enabling:
- Reproducible builds
- Version control friendly
- Predictable behavior

## Development

### Building

```bash
pnpm install
pnpm typecheck
```

### Testing

```bash
# Run unit tests
pnpm vitest run packages/adapters/bob-shell/src/server/__tests__/

# Run specific test file
pnpm vitest run packages/adapters/bob-shell/src/server/__tests__/error-classification.test.ts

# Type check
cd packages/adapters/bob-shell && pnpm typecheck
```

The adapter can also be tested via Paperclip's adapter test environment:

```bash
# In Paperclip UI
Settings → Agents → [Agent] → Test Environment
```

## Troubleshooting

### Bob Shell Not Found

**Error**: `Command not found: bob`

**Solution**: Ensure Bob Shell is installed and in PATH, or configure absolute path in `command` field.

### MCP Connection Failed

**Error**: Bob Shell cannot connect to Paperclip MCP server

**Solution**: 
- Verify `PAPERCLIP_API_URL` is accessible from Bob Shell process
- Check `PAPERCLIP_API_KEY` is valid
- Ensure Paperclip MCP server is running

### Workspace Sync Issues

**Error**: `.bob/` files not generated or incorrect

**Solution**:
- Check agent has write permissions to workspace directory
- Verify company skills are properly configured
- Review Paperclip logs for sync errors

### Retry Failures

**Error**: Retries exhausted, task still failing

**Solution**:
- Check error classification in logs
- Verify error is actually retryable
- Increase `maxRetries` if needed
- Check for underlying issues (API keys, network, etc.)

### Cache Issues

**Error**: Prompt bundle cache not working

**Solution**:
- Check write permissions to cache directory
- Verify cache directory exists: `~/.paperclip/instances/default/companies/{company_id}/bob-prompt-cache`
- Review logs for cache-related errors
- Clear cache and retry

## Security Considerations

- API keys are injected via environment variables, not written to disk
- Secrets should be managed through Paperclip's secret store
- Bob Shell runs with same permissions as Paperclip server process
- Prompt bundles may contain sensitive instructions - cache directory should be protected

## Session Management

The adapter includes session management infrastructure:

### Current Implementation

- **Session Resume Support**: Adapter checks for existing sessions and attempts to resume
- **Session Validation**: Validates session compatibility (working directory and prompt bundle must match)
- **Retry Logic**: Automatically retries with fresh session if resume fails
- **Session Clearing**: Clears invalid sessions to prevent accumulation

### Session Resume Flow

```typescript
1. Check runtime.sessionParams for existing session
2. Validate session is compatible with current working directory and prompt bundle
3. Pass --resume-session <id> to Bob Shell (when supported)
4. On session error, retry with fresh session
5. Store new session ID in result for next run
```

### Waiting for Bob Shell Support

The adapter is ready to use sessions once Bob Shell implements:
- `--resume-session <id>` CLI flag
- Session ID output in stdout
- Session error detection and reporting

## Limitations

- Bob Shell must support the configured mode (default: `paperclip-agent`)
- Session persistence requires Bob Shell implementation (infrastructure ready)
- Usage tracking and cost calculation require Bob Shell output format enhancements
- Prompt bundle cache grows over time (manual cleanup required)

## Future Enhancements

- Automatic cache cleanup (LRU eviction)
- Usage tracking and cost calculation (waiting for Bob Shell output format)
- Model detection and reporting (waiting for Bob Shell output format)
- Incremental workspace sync (only update changed files)
- Bob Shell version detection and compatibility checks
- Advanced workspace strategies (git worktrees, containers)
- JSON stream parsing (when Bob Shell supports it)

## Recent Improvements

### Phase A: Error Handling & Retry Logic (2026-04-29)

- ✅ Enhanced error classification with 6 error types
- ✅ Intelligent retry logic with exponential backoff
- ✅ Configurable retry attempts and delays
- ✅ Detailed error messages with hints
- ✅ Comprehensive test suite (23 tests)
- ✅ Full TypeScript type safety

See `doc/bob-shell-adapter-phase1-complete.md` for details.

### Phase B: Prompt Optimization (In Progress)

- ✅ Prompt bundle caching system
- ✅ Bootstrap prompt support
- ✅ Content-addressed bundles
- 🔄 Performance benchmarks (pending)
- 🔄 Cache cleanup utilities (pending)
## Setup Guide

See [docs/SETUP.md](./docs/SETUP.md) for end-to-end installation, agent
configuration, and troubleshooting.
