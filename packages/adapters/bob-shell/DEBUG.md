# Bob Shell Adapter - MCP Connection Debugging Guide

## Issue: Bob Shell not connecting to Paperclip MCP server

## Test Results

### ✅ MCP Server Package
- Package: `@paperclipai/mcp-server` v0.1.0
- Status: Published and working
- Test: `npx -y @paperclipai/mcp-server` runs successfully

### ✅ Bob Shell Installation
- Version: 1.0.1
- Command: `bob` available in PATH
- MCP Support: `bob mcp list` command works

### ✅ MCP Connection Test
Created test workspace with minimal `.bob/mcp.json`:
```json
{
  "mcpServers": {
    "paperclip": {
      "command": "npx",
      "args": ["-y", "@paperclipai/mcp-server"],
      "env": {
        "PAPERCLIP_API_URL": "http://localhost:3100",
        "PAPERCLIP_API_KEY": "test-key-123",
        "PAPERCLIP_COMPANY_ID": "test-company",
        "PAPERCLIP_AGENT_ID": "test-agent",
        "PAPERCLIP_RUN_ID": "test-run"
      }
    }
  }
}
```

Result: `bob mcp list` shows "✓ paperclip: Connected"

## Potential Issues in Adapter Integration

### 1. **Timing Issue - Workspace Sync vs Bob Launch**
The adapter syncs `.bob/` workspace BEFORE launching Bob Shell:
```typescript
// In execute.ts
await syncBobWorkspace({ ... });  // Creates .bob/mcp.json
const proc = await runChildProcess(...);  // Launches bob
```

**Potential Problem**: Bob Shell might cache MCP server configs or not reload them if the process is already running.

**Solution**: Ensure Bob Shell reads fresh config on each launch.

### 2. **Environment Variable Propagation**
The adapter passes environment variables to Bob Shell process:
```typescript
env.PAPERCLIP_API_URL = apiUrl;
env.PAPERCLIP_API_KEY = apiKey;
// etc.
```

But the MCP server config in `.bob/mcp.json` also has its own `env` section.

**Potential Problem**: Environment variables might not be properly inherited by the MCP server subprocess spawned by Bob Shell.

**Solution**: Verify Bob Shell properly passes environment variables from `.bob/mcp.json` to MCP server subprocesses.

### 3. **Working Directory Mismatch**
The adapter creates `.bob/mcp.json` in the `cwd` directory:
```typescript
const bobDir = path.join(cwd, ".bob");
```

**Potential Problem**: Bob Shell might be looking for `.bob/mcp.json` in a different directory (e.g., user home, current working directory at launch time).

**Solution**: Verify Bob Shell's MCP config resolution order.

### 4. **MCP Server Initialization Timeout**
Bob Shell might timeout waiting for MCP server to initialize.

**Potential Problem**: `npx -y @paperclipai/mcp-server` takes time to download/run on first use.

**Solution**: Pre-install the package or increase timeout.

### 5. **Missing Required Environment Variables**
The MCP server requires:
- `PAPERCLIP_API_URL` (required)
- `PAPERCLIP_API_KEY` (required)
- `PAPERCLIP_COMPANY_ID` (optional)
- `PAPERCLIP_AGENT_ID` (optional)
- `PAPERCLIP_RUN_ID` (optional)

**Potential Problem**: If API_URL or API_KEY are missing/invalid, MCP server fails to start.

**Solution**: Add validation and better error messages.

## Debugging Steps

### Step 1: Enable Bob Shell Debug Logging
Run Bob Shell with debug output to see MCP server initialization:
```bash
DEBUG=* bob --chat-mode paperclip-agent
```

### Step 2: Test MCP Server Manually
In the workspace directory:
```bash
cd /path/to/workspace
cat .bob/mcp.json  # Verify config exists
bob mcp list       # Check if paperclip server is detected
bob mcp test paperclip  # Test connection (if command exists)
```

### Step 3: Check MCP Server Logs
The MCP server writes to stderr. Check if Bob Shell captures/displays these logs:
```bash
# In workspace with .bob/mcp.json
PAPERCLIP_API_URL="http://localhost:3100" \
PAPERCLIP_API_KEY="test-key" \
npx -y @paperclipai/mcp-server 2>&1
```

### Step 4: Verify Paperclip API Accessibility
Ensure the Paperclip API is running and accessible:
```bash
curl http://localhost:3100/api/health
```

### Step 5: Test Adapter Workspace Sync
Create a test script to verify workspace sync:
```typescript
import { syncBobWorkspace } from "@paperclipai/adapter-bob-shell/server";

await syncBobWorkspace({
  cwd: "/tmp/test-workspace",
  companyId: "test-company",
  agentId: "test-agent",
  mode: "paperclip-agent",
  skills: [],
  env: {
    PAPERCLIP_API_URL: "http://localhost:3100",
    PAPERCLIP_API_KEY: "test-key",
    PAPERCLIP_COMPANY_ID: "test-company",
    PAPERCLIP_AGENT_ID: "test-agent",
    PAPERCLIP_RUN_ID: "test-run",
  },
  onLog: async (stream, chunk) => console.log(`[${stream}]`, chunk),
});

// Then check if .bob/mcp.json was created correctly
```

## Recommended Fixes

### Fix 1: Add MCP Connection Verification
Add a post-sync verification step in `execute.ts`:
```typescript
await syncBobWorkspace({ ... });

// Verify MCP server is accessible
const mcpCheckResult = await runChildProcess(
  "bob-mcp-check",
  command,
  ["mcp", "list"],
  { cwd, env: runtimeEnv, timeoutSec: 10, graceSec: 2, onLog: async () => {} }
);

if (!mcpCheckResult.stdout.includes("paperclip") || !mcpCheckResult.stdout.includes("Connected")) {
  throw new Error("Paperclip MCP server not detected by Bob Shell");
}
```

### Fix 2: Add Environment Variable Validation
In `workspace.ts`, validate required env vars before generating mcp.json:
```typescript
function generatePaperclipMcpServer(env: Record<string, string>): BobMcpServer {
  const apiUrl = env.PAPERCLIP_API_URL;
  const apiKey = env.PAPERCLIP_API_KEY;
  
  if (!apiUrl || !apiKey) {
    throw new Error(
      "Missing required environment variables for Paperclip MCP server: " +
      `PAPERCLIP_API_URL=${!!apiUrl}, PAPERCLIP_API_KEY=${!!apiKey}`
    );
  }
  
  // ... rest of function
}
```

### Fix 3: Add Detailed Logging
Enhance logging in `syncBobWorkspace`:
```typescript
if (onLog) {
  await onLog("stdout", `[paperclip] MCP server config:\n${JSON.stringify(paperclipServer, null, 2)}\n`);
  await onLog("stdout", `[paperclip] Environment variables:\n`);
  await onLog("stdout", `  PAPERCLIP_API_URL: ${env.PAPERCLIP_API_URL}\n`);
  await onLog("stdout", `  PAPERCLIP_API_KEY: ${env.PAPERCLIP_API_KEY ? '***' : '(not set)'}\n`);
  await onLog("stdout", `  PAPERCLIP_COMPANY_ID: ${env.PAPERCLIP_COMPANY_ID}\n`);
  await onLog("stdout", `  PAPERCLIP_AGENT_ID: ${env.PAPERCLIP_AGENT_ID}\n`);
}
```

### Fix 4: Pre-install MCP Server Package
Add a pre-flight check to install the MCP server package:
```typescript
// Before launching Bob Shell
await runChildProcess(
  "npm-install-mcp",
  "npm",
  ["install", "-g", "@paperclipai/mcp-server@latest"],
  { cwd, env: runtimeEnv, timeoutSec: 60, graceSec: 5, onLog }
);
```

## Next Steps

1. **Reproduce the issue**: Run a Paperclip agent with Bob Shell adapter and capture full logs
2. **Check Bob Shell logs**: Look for MCP initialization errors
3. **Verify API connectivity**: Ensure Paperclip API is accessible from Bob Shell's perspective
4. **Test with minimal config**: Use the test workspace approach to isolate the issue
5. **Add diagnostics**: Implement the recommended fixes above

## Test Workspace Location
A test workspace was created at: `/tmp/bob-mcp-test-55759`

To test manually:
```bash
cd /tmp/bob-mcp-test-55759
bob mcp list  # Should show paperclip as Connected
bob --chat-mode advanced  # Try using the MCP server
```

Cleanup:
```bash
rm -rf /tmp/bob-mcp-test-55759
```
