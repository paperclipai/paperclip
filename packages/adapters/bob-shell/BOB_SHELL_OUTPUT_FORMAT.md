# Bob Shell Output Format Requirements

**Date:** 2026-04-15  
**Purpose:** Define the output format Bob Shell must produce for full adapter integration

## Overview

The Bob Shell adapter currently extracts basic information from stdout. To achieve feature parity with Claude adapter, Bob Shell needs to output structured metadata in a parseable format.

## Current Implementation

### What We Extract Now

```typescript
interface BobStreamResult {
  summary: string;              // ✅ Extracted from attempt_completion
  finalResult: string | null;   // ✅ Extracted from attempt_completion
  assistantTexts: string[];     // ✅ Extracted from cleaned stdout
  thinkingTexts: string[];      // ✅ Extracted from <thinking> tags
  
  // Not yet extracted (placeholders):
  sessionId?: string | null;
  model?: string | null;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  } | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
}
```

### Current Parsing Logic

The adapter parses:
1. `<attempt_completion><result>...</result></attempt_completion>` for final result
2. `<thinking>...</thinking>` for thinking blocks
3. Tool calls and results (various XML formats)
4. Assistant text (cleaned stdout minus XML tags)

## Required Enhancements

### 1. Session Management Output

Bob Shell should output session information when it supports session persistence:

```xml
<session_info>
  <session_id>bob-session-abc123</session_id>
  <created_at>2026-04-15T05:00:00Z</created_at>
</session_info>
```

**When to output:**
- At the start of a new session
- When resuming an existing session
- In the final result metadata

**Adapter will:**
- Extract `session_id` and store in `sessionParams`
- Pass `--resume-session <id>` on subsequent runs
- Clear session on errors or max turns

### 2. Model Information Output

Bob Shell should report which model it's using:

```xml
<model_info>
  <model>claude-3-5-sonnet-20241022</model>
  <provider>anthropic</provider>
</model_info>
```

**When to output:**
- At session initialization
- When model changes mid-session

**Adapter will:**
- Extract and include in result metadata
- Display in UI alongside run information

### 3. Usage Tracking Output

Bob Shell should report token usage for billing and monitoring:

```xml
<usage_info>
  <input_tokens>1500</input_tokens>
  <cached_input_tokens>800</cached_input_tokens>
  <output_tokens>450</output_tokens>
  <total_tokens>2750</total_tokens>
</usage_info>
```

**When to output:**
- After each turn or at completion
- Cumulative for the entire run

**Adapter will:**
- Extract and aggregate usage
- Store in database for analytics
- Display in UI

### 4. Cost Information Output

Bob Shell should calculate and report costs:

```xml
<cost_info>
  <cost_usd>0.0234</cost_usd>
  <billing_type>api</billing_type>
  <biller>anthropic</biller>
</cost_info>
```

**When to output:**
- At run completion
- When cost information is available

**Adapter will:**
- Extract and store for budget tracking
- Display in UI
- Trigger budget alerts if configured

### 5. Structured Result Output

Bob Shell should provide a structured JSON result at completion:

```xml
<result_json>
{
  "status": "success",
  "summary": "Task completed successfully",
  "session_id": "bob-session-abc123",
  "model": "claude-3-5-sonnet-20241022",
  "usage": {
    "input_tokens": 1500,
    "cached_input_tokens": 800,
    "output_tokens": 450
  },
  "cost_usd": 0.0234,
  "metadata": {
    "tools_used": ["read_file", "write_to_file", "execute_command"],
    "files_modified": 3,
    "commands_executed": 2
  }
}
</result_json>
```

**When to output:**
- At run completion (success or error)

**Adapter will:**
- Parse and extract all metadata
- Store in database
- Use for analytics and reporting

## Recommended Output Format

### Option 1: Inline XML Tags (Current Approach)

Bob Shell continues to output XML tags inline with stdout:

```
Starting task...
<thinking>Analyzing requirements...</thinking>
I'll read the file first.
<read_file>
<file_path>/path/to/file.txt</file_path>
</read_file>
Tool <read_file> status: Success
...
<session_info>
<session_id>bob-session-abc123</session_id>
</session_info>
<usage_info>
<input_tokens>1500</input_tokens>
<output_tokens>450</output_tokens>
</usage_info>
<attempt_completion>
<result>Task completed successfully</result>
</attempt_completion>
```

**Pros:**
- Minimal changes to Bob Shell
- Adapter already parses XML tags
- Progressive updates work naturally

**Cons:**
- Mixed content (text + XML)
- Harder to parse complex structures

### Option 2: JSON Stream Events (Like Claude)

Bob Shell outputs newline-delimited JSON events:

```json
{"type":"system","subtype":"init","session_id":"bob-session-abc123","model":"claude-3-5-sonnet-20241022","ts":"2026-04-15T05:00:00Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Starting task..."}]},"ts":"2026-04-15T05:00:01Z"}
{"type":"thinking","content":"Analyzing requirements...","ts":"2026-04-15T05:00:02Z"}
{"type":"tool_use","name":"read_file","input":{"file_path":"/path/to/file.txt"},"ts":"2026-04-15T05:00:03Z"}
{"type":"tool_result","content":"file contents...","is_error":false,"ts":"2026-04-15T05:00:04Z"}
{"type":"result","result":"Task completed successfully","usage":{"input_tokens":1500,"output_tokens":450},"cost_usd":0.0234,"session_id":"bob-session-abc123","ts":"2026-04-15T05:00:10Z"}
```

**Pros:**
- Clean separation of events and content
- Easy to parse incrementally
- Structured metadata
- Matches Claude's approach

**Cons:**
- Requires significant Bob Shell changes
- More complex implementation

### Option 3: Hybrid Approach

Bob Shell outputs text normally but adds a final JSON summary:

```
Starting task...
I'll read the file first.
[... normal output ...]
Task completed successfully

---BOB-METADATA---
{
  "session_id": "bob-session-abc123",
  "model": "claude-3-5-sonnet-20241022",
  "usage": {
    "input_tokens": 1500,
    "cached_input_tokens": 800,
    "output_tokens": 450
  },
  "cost_usd": 0.0234,
  "summary": "Task completed successfully"
}
---END-METADATA---
```

**Pros:**
- Minimal changes to Bob Shell
- Clean metadata extraction
- Backward compatible

**Cons:**
- No progressive metadata updates
- Requires delimiter parsing

## Recommended Implementation: Option 2 (JSON Stream)

**Rationale:**
- Matches Claude adapter's proven approach
- Enables progressive metadata extraction
- Clean separation of concerns
- Future-proof for additional metadata

**Migration Path:**
1. Add `--output-format json-stream` flag to Bob Shell
2. Implement JSON event streaming
3. Update adapter to parse JSON stream
4. Keep XML parsing as fallback for compatibility

## Adapter Changes Required

### 1. Enhanced Stream Parser

```typescript
export function parseBobShellStream(stdout: string): BobStreamResult {
  // Try JSON stream format first
  const jsonResult = tryParseJsonStream(stdout);
  if (jsonResult) return jsonResult;
  
  // Fall back to XML parsing
  return parseXmlStream(stdout);
}

function tryParseJsonStream(stdout: string): BobStreamResult | null {
  const lines = stdout.split('\n');
  let sessionId: string | null = null;
  let model: string | null = null;
  let usage: UsageSummary | null = null;
  let costUsd: number | null = null;
  const assistantTexts: string[] = [];
  const thinkingTexts: string[] = [];
  let finalResult: string | null = null;
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    try {
      const event = JSON.parse(line);
      const type = event.type;
      
      if (type === 'system' && event.subtype === 'init') {
        sessionId = event.session_id ?? null;
        model = event.model ?? null;
      } else if (type === 'assistant') {
        // Extract assistant text
      } else if (type === 'thinking') {
        thinkingTexts.push(event.content);
      } else if (type === 'result') {
        finalResult = event.result;
        usage = event.usage ?? null;
        costUsd = event.cost_usd ?? null;
        sessionId = event.session_id ?? sessionId;
      }
    } catch {
      // Not JSON, skip
    }
  }
  
  // Generate summary from collected data
  const summary = generateSummary(finalResult, assistantTexts, thinkingTexts);
  
  return {
    summary,
    finalResult,
    assistantTexts,
    thinkingTexts,
    sessionId,
    model,
    usage,
    costUsd,
    resultJson: finalResult ? { result: finalResult } : null,
  };
}
```

### 2. Session Resume Support

```typescript
const buildBobArgs = (resumeSessionId: string | null) => {
  const args = ["--chat-mode", mode];
  if (resumeSessionId) {
    args.push("--resume-session", resumeSessionId);
  }
  args.push("--output-format", "json-stream"); // Request JSON output
  args.push(...extraArgs);
  return args;
};
```

### 3. Result Builder Enhancement

Already implemented in `buildBobResult()` - just needs Bob Shell to provide the data.

## Testing Strategy

### Phase 1: XML Enhancement (Current)
1. Add XML tags for session, model, usage, cost
2. Test extraction in adapter
3. Verify backward compatibility

### Phase 2: JSON Stream (Future)
1. Implement JSON stream in Bob Shell
2. Add JSON parser to adapter
3. Test progressive updates
4. Verify all metadata extraction

### Phase 3: Validation
1. Compare with Claude adapter output
2. Verify UI displays all metadata
3. Test session resume
4. Validate cost tracking

## Example Complete Output

### XML Format (Phase 1)
```xml
<session_info>
<session_id>bob-session-abc123</session_id>
<model>claude-3-5-sonnet-20241022</model>
</session_info>

Starting task analysis...

<thinking>
Need to read the configuration file first
</thinking>

Reading configuration...

<read_file>
<file_path>/path/to/config.json</file_path>
</read_file>

Tool <read_file> status: Success

Configuration loaded. Making changes...

<write_to_file>
<file_path>/path/to/output.txt</file_path>
<content>Updated content</content>
</write_to_file>

Tool <write_to_file> status: Success

<usage_info>
<input_tokens>1500</input_tokens>
<cached_input_tokens>800</cached_input_tokens>
<output_tokens>450</output_tokens>
</usage_info>

<cost_info>
<cost_usd>0.0234</cost_usd>
</cost_info>

<attempt_completion>
<result>
Successfully updated the configuration file.
Changes have been written to /path/to/output.txt
</result>
</attempt_completion>
```

### JSON Stream Format (Phase 2)
```json
{"type":"system","subtype":"init","session_id":"bob-session-abc123","model":"claude-3-5-sonnet-20241022","ts":"2026-04-15T05:00:00Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Starting task analysis..."}]},"ts":"2026-04-15T05:00:01Z"}
{"type":"thinking","content":"Need to read the configuration file first","ts":"2026-04-15T05:00:02Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Reading configuration..."}]},"ts":"2026-04-15T05:00:03Z"}
{"type":"tool_use","name":"read_file","input":{"file_path":"/path/to/config.json"},"tool_use_id":"toolu_123","ts":"2026-04-15T05:00:04Z"}
{"type":"tool_result","tool_use_id":"toolu_123","content":"config contents...","is_error":false,"ts":"2026-04-15T05:00:05Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Configuration loaded. Making changes..."}]},"ts":"2026-04-15T05:00:06Z"}
{"type":"tool_use","name":"write_to_file","input":{"file_path":"/path/to/output.txt","content":"Updated content"},"tool_use_id":"toolu_124","ts":"2026-04-15T05:00:07Z"}
{"type":"tool_result","tool_use_id":"toolu_124","content":"Success","is_error":false,"ts":"2026-04-15T05:00:08Z"}
{"type":"result","result":"Successfully updated the configuration file.\nChanges have been written to /path/to/output.txt","usage":{"input_tokens":1500,"cache_read_input_tokens":800,"output_tokens":450},"cost_usd":0.0234,"session_id":"bob-session-abc123","ts":"2026-04-15T05:00:10Z"}
```

## Summary

The Bob Shell adapter is ready to extract enhanced metadata once Bob Shell provides it. The recommended approach is:

1. **Short term:** Add XML tags for session, model, usage, cost
2. **Long term:** Implement JSON stream format matching Claude
3. **Always:** Maintain backward compatibility with current XML parsing

This will enable full feature parity with the Claude adapter while preserving Bob Shell's unique characteristics.
