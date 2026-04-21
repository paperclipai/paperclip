# Token Compression Migration Guide

## Overview

Paperclip now includes automatic prompt compression to reduce token usage by 80% while preserving critical task context. This affects all adapters and is enabled by default.

## What Changed

### Prompt Compression
- **Input prompts** are now compressed using caveman-style formatting
- **Token reduction**: 50KB prompts → 5KB (80% reduction)
- **Preserved**: Task-critical information, code blocks, technical terms
- **Removed**: Conversational fillers, articles, transition phrases

### Caveman Output Formatting
- **Model outputs** are formatted in caveman style for 60-75% token reduction
- **Preserved**: Code blocks, JSON, critical negations
- **Compressed**: Explanatory text, articles, filler phrases

### Tool Schema Optimization
- **Tool descriptions** compressed to <100 characters
- **Limited to 15 tools** per request for relevance
- **Schema overhead** reduced by 50-60%

## Configuration

### Per-Agent Configuration
```typescript
{
  "adapterConfig": {
    "promptCompression": {
      "enabled": true,
      "caveman": {
        "enabled": true,
        "intensity": "full", // "lite" | "full" | "ultra"
        "preserveCodeBlocks": true
      }
    }
  }
}
```

### Disabling Compression
If compression breaks parsing for your use case:
```typescript
{
  "adapterConfig": {
    "promptCompression": {
      "enabled": false
    }
  }
}
```

## Examples

### Before (Verbose)
```
I'd be happy to help you with this issue. The reason your component is re-rendering is likely because you're creating a new object reference on each render cycle. Furthermore, this causes React to think the props have changed. Additionally, you should use useCallback or useMemo to stabilize references.
```

### After (Caveman)
```
Comp re-renders. New obj ref each render. Stabilize w/ useCallback or useMemo.
```

### Tool Schema Before
```json
{
  "name": "search_files",
  "description": "Use this tool to search for files in the workspace that match the given criteria",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The search query to match against file contents"
      }
    }
  }
}
```

### Tool Schema After
```json
{
  "name": "search_files",
  "description": "Search workspace files",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query"
      }
    }
  }
}
```

## Troubleshooting

### Compression Breaks Code Understanding
**Symptom**: Model produces incorrect code or misunderstands requirements
**Solution**: Disable caveman formatting for that agent
```typescript
{
  "adapterConfig": {
    "promptCompression": {
      "caveman": { "enabled": false }
    }
  }
}
```

### Tool Calls Not Working
**Symptom**: Model doesn't use tools properly after compression
**Solution**: Reduce compression intensity
```typescript
{
  "adapterConfig": {
    "promptCompression": {
      "caveman": { "intensity": "lite" }
    }
  }
}
```

### Context Window Issues
**Symptom**: Model loses track of conversation history
**Solution**: Check session management is enabled (automatic for local models)

## Performance Impact

- **Token savings**: 70-85% reduction in prompt tokens
- **Latency**: Minimal impact (compression is fast)
- **Cost**: Significant reduction for API-based models
- **Quality**: Preserved for task-critical information

## Migration Timeline

- **Phase 1**: Compression enabled by default for all new agents
- **Phase 2**: Existing agents migrated automatically
- **Phase 3**: Ultra compression for high-traffic deployments

## Testing

Run the compression tests:
```bash
pnpm test packages/adapter-utils/src/__tests__/compression.test.ts
```

Validate with your agents:
1. Create test agent with compression enabled
2. Run sample tasks
3. Compare output quality vs. disabled compression
4. Adjust intensity as needed