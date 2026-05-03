# Bob Shell Adapter - Dashboard Status Updates Implementation

## Issue: Dashboard not showing status updates from Designer agent

### Root Cause Analysis

**Claude Adapter Behavior:**
- Uses `parseClaudeStreamJson()` to extract progressive summaries from streaming JSON output
- Summaries are automatically captured in the `AdapterExecutionResult.summary` field
- Paperclip's heartbeat service publishes these as live events to the dashboard

**Bob Shell Adapter Current Behavior:**
- Has `parseBobShellStream()` function that extracts progressive summaries
- Parses output in `wrappedOnLog` but **only accumulates internally**
- Summary is only set in final `AdapterExecutionResult` after process completes
- **No progressive status updates during execution**

### The Problem

```typescript
// In execute.ts (lines 308-318)
const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
  if (stream === "stdout") {
    accumulatedStdout += chunk;
    // Parse accumulated stdout to extract progressive summary
    const parsed = parseBobShellStream(accumulatedStdout);
    // ❌ The summary is parsed but NEVER published!
    // The comment says "will be used by live event system" but it's not actually sent
  }
  // Forward to original onLog
  await onLog(stream, chunk);
};
```

The parsed summary exists but is never exposed to the dashboard.

### Solution Options

#### Option 1: Publish Summary via Special Log Format (Recommended)

Emit the progressive summary as a special log message that Paperclip's heartbeat service can detect and publish as a status update.

**Implementation:**

```typescript
// In execute.ts, modify wrappedOnLog:
const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
  if (stream === "stdout") {
    accumulatedStdout += chunk;
    const parsed = parseBobShellStream(accumulatedStdout);
    
    // Publish progressive summary as a special log message
    if (parsed.summary && parsed.summary.length > 0) {
      // Use a special format that Paperclip can detect
      await onLog("stdout", `\n[paperclip:status] ${parsed.summary}\n`);
    }
  }
  // Forward original chunk to onLog
  await onLog(stream, chunk);
};
```

**Pros:**
- Minimal changes to adapter
- Uses existing log infrastructure
- No changes to Paperclip core needed

**Cons:**
- Adds extra log noise
- Requires filtering in UI to avoid duplicate display

#### Option 2: Add onStatusUpdate Callback (Better Architecture)

Extend the adapter execution context to include a dedicated status update callback.

**Implementation:**

```typescript
// In @paperclipai/adapter-utils types:
export interface AdapterExecutionContext {
  // ... existing fields
  onStatusUpdate?: (summary: string) => Promise<void>; // NEW
}

// In bob-shell execute.ts:
const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
  if (stream === "stdout") {
    accumulatedStdout += chunk;
    const parsed = parseBobShellStream(accumulatedStdout);
    
    // Publish progressive summary via dedicated callback
    if (parsed.summary && parsed.summary.length > 0 && onStatusUpdate) {
      await onStatusUpdate(parsed.summary);
    }
  }
  await onLog(stream, chunk);
};

// In server/src/services/heartbeat.ts (around line 3184):
const onStatusUpdate = async (summary: string) => {
  publishLiveEvent({
    companyId: run.companyId,
    type: "heartbeat.run.status",
    payload: {
      runId: run.id,
      agentId: run.agentId,
      summary,
      ts: new Date().toISOString(),
    },
  });
};

// Pass to adapter:
const adapterResult = await adapter.execute({
  // ... existing fields
  onStatusUpdate, // NEW
});
```

**Pros:**
- Clean separation of concerns
- No log pollution
- Explicit status update mechanism
- Easy to add to other adapters

**Cons:**
- Requires changes to adapter-utils types
- Requires changes to heartbeat service
- More invasive change

#### Option 3: Return Progressive Summaries in AdapterExecutionResult (Simplest)

Add a `progressiveSummaries` field to the result that Paperclip can publish after execution.

**Implementation:**

```typescript
// In @paperclipai/adapter-utils types:
export interface AdapterExecutionResult {
  // ... existing fields
  progressiveSummaries?: Array<{ ts: string; summary: string }>; // NEW
}

// In bob-shell execute.ts:
const progressiveSummaries: Array<{ ts: string; summary: string }> = [];
let lastSummary = "";

const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
  if (stream === "stdout") {
    accumulatedStdout += chunk;
    const parsed = parseBobShellStream(accumulatedStdout);
    
    // Track progressive summaries
    if (parsed.summary && parsed.summary !== lastSummary) {
      progressiveSummaries.push({
        ts: new Date().toISOString(),
        summary: parsed.summary,
      });
      lastSummary = parsed.summary;
    }
  }
  await onLog(stream, chunk);
};

// In final result:
return {
  // ... existing fields
  progressiveSummaries, // NEW
};
```

**Pros:**
- Minimal changes
- No new callbacks needed
- Summaries available for post-processing

**Cons:**
- Not real-time (only available after execution completes)
- Doesn't solve the dashboard update problem during execution

### Recommended Implementation: Option 2 (onStatusUpdate)

This is the cleanest architectural solution that:
1. Provides real-time status updates during execution
2. Doesn't pollute logs
3. Can be reused by other adapters
4. Follows the same pattern as `onLog`, `onMeta`, `onSpawn`

### Implementation Steps

#### Step 1: Update adapter-utils types

```typescript
// packages/adapter-utils/src/types.ts
export interface AdapterExecutionContext {
  runId: string;
  agent: AgentContext;
  runtime: RuntimeContext;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: ProcessSpawnMeta) => Promise<void>;
  onStatusUpdate?: (summary: string) => Promise<void>; // NEW
  authToken?: string;
}
```

#### Step 2: Update Bob Shell adapter

```typescript
// packages/adapters/bob-shell/src/server/execute.ts
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, onStatusUpdate, authToken } = ctx;
  
  // ... existing code ...
  
  let accumulatedStdout = "";
  let lastPublishedSummary = "";
  
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stdout") {
      accumulatedStdout += chunk;
      const parsed = parseBobShellStream(accumulatedStdout);
      
      // Publish progressive summary if it changed and callback is available
      if (parsed.summary && 
          parsed.summary.length > 0 && 
          parsed.summary !== lastPublishedSummary && 
          onStatusUpdate) {
        await onStatusUpdate(parsed.summary);
        lastPublishedSummary = parsed.summary;
      }
    }
    await onLog(stream, chunk);
  };
  
  // ... rest of execute function ...
}
```

#### Step 3: Update heartbeat service

```typescript
// server/src/services/heartbeat.ts (around line 3184)
const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
  // ... existing onLog implementation ...
};

const onStatusUpdate = async (summary: string) => {
  publishLiveEvent({
    companyId: run.companyId,
    type: "heartbeat.run.status",
    payload: {
      runId: run.id,
      agentId: run.agentId,
      summary,
      ts: new Date().toISOString(),
    },
  });
};

// ... later in the code (around line 3305) ...
const adapterResult = await adapter.execute({
  runId,
  agent,
  runtime: runtimeForAdapter,
  config: runtimeConfig,
  context,
  onLog,
  onMeta: onAdapterMeta,
  onSpawn: async (meta) => { /* ... */ },
  onStatusUpdate, // NEW
  authToken: authToken ?? undefined,
});
```

#### Step 4: Update UI to display status updates

```typescript
// ui/src/components/RunTranscriptView.tsx (or similar)
// Subscribe to "heartbeat.run.status" live events
// Display the summary in a status indicator above the transcript
```

### Testing

1. **Create test issue** with Bob Shell agent assigned
2. **Start agent run** and watch dashboard
3. **Verify status updates** appear progressively as Bob Shell works
4. **Compare with Claude agent** - should have similar update frequency

### Alternative: Quick Fix with Log Parsing

If the full implementation is too invasive, a quick fix is to parse special log messages:

```typescript
// In bob-shell execute.ts:
const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
  if (stream === "stdout") {
    accumulatedStdout += chunk;
    const parsed = parseBobShellStream(accumulatedStdout);
    
    if (parsed.summary && parsed.summary !== lastPublishedSummary) {
      // Emit as special log that UI can parse
      await onLog("stdout", `\x1b[90m[status: ${parsed.summary}]\x1b[0m\n`);
      lastPublishedSummary = parsed.summary;
    }
  }
  await onLog(stream, chunk);
};
```

Then in the UI, detect and extract these special log messages for display in a status bar.

## Conclusion

The Bob Shell adapter has all the parsing logic needed for progressive status updates, but lacks the mechanism to publish them to the dashboard. Implementing `onStatusUpdate` callback is the cleanest solution that provides real-time updates similar to Claude's behavior.
