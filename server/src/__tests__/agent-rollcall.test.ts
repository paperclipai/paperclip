/**
 * Tests for the agent-rollcall skill scripts.
 *
 * Strategy: inject a mock `curl` binary at the front of PATH that logs every
 * call to a temp file (REQUEST_LOG_PATH) and returns canned responses.
 * This avoids any real network activity and works around EPERM on port binding.
 *
 * agent-comment.sh resolves identifier-style refs (LINAA-42) via GET first,
 * so the mock must handle both GET /api/issues/<id> and POST /api/issues/<id>/comments.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const __dir = path.dirname(fileURLToPath(import.meta.url));

const PROBE_SCRIPT = path.resolve(__dir, "../../../local/skills/agent-rollcall/scripts/agent-rollcall-probe.sh");
const POLL_SCRIPT  = path.resolve(__dir, "../../../local/skills/agent-delegate/scripts/agent-poll-issue.sh");
const COMMENT_SCRIPT = path.resolve(__dir, "../../../local/skills/agent-delegate/scripts/agent-comment.sh");

// ---------------------------------------------------------------------------
// Mock curl (Node.js script written to a temp dir and prepended to PATH)
// ---------------------------------------------------------------------------

/** The mock curl Node.js source. REQUEST_LOG_PATH is injected via env. */
function mockCurlSource(logPath: string): string {
  // Escape the path for embedding in the script
  const safeLog = JSON.stringify(logPath);
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');

// Parse curl-style args: -X <method>  -H <header>  -d <data>  <url>
// Flags without values: -fs -f -s
let method = 'GET';
let data   = '';
let url    = '';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-X')       { method = args[++i]; }
  else if (a === '-d')  { data   = args[++i]; }
  else if (a === '-H')  { i++;                } // skip header value
  else if (/^-[a-zA-Z]+$/.test(a)) { /* flag like -fs, -s, -f */ }
  else { url = a; }
}

// Log the call
const logPath = ${safeLog};
let log = [];
try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
const body = data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null;
log.push({ method, url, body });
fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

// Route responses
// POST /api/companies/<id>/issues  (create issue)
if (method === 'POST' && url.endsWith('/issues')) {
  const idk = body && body.title && body.title.includes('Stark') ? 'LINAA-43' : 'LINAA-42';
  process.stdout.write(JSON.stringify({ identifier: idk, id: 'uuid-' + idk }) + '\\n');
  process.exit(0);
}

// GET /api/issues/<identifier>  (poll or identifier resolution)
if (method === 'GET' && url.includes('/api/issues/')) {
  const parts = url.split('/');
  const id = parts[parts.length - 1].split('?')[0];
  const status = id === 'LINAA-43' ? 'in_progress' : 'done';
  process.stdout.write(JSON.stringify({ id: 'uuid-' + id, identifier: id, status }) + '\\n');
  process.exit(0);
}

// POST /api/issues/<id>/comments  (post comment)
if (method === 'POST' && url.includes('/comments')) {
  process.stdout.write(JSON.stringify({ id: 'comment-123' }) + '\\n');
  process.exit(0);
}

process.stderr.write('mock-curl: unhandled ' + method + ' ' + url + '\\n');
process.exit(1);
`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("agent-rollcall skill", () => {
  let tmpDir: string;
  let logPath: string;

  const baseEnv = () => ({
    ...process.env,
    PATH: `${tmpDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    REQUEST_LOG_PATH: logPath,
    PAPERCLIP_API_URL: "http://mock.local",
    PAPERCLIP_API_KEY: "test-key",
    PAPERCLIP_COMPANY_ID: "company-123",
  });

  const readLog = async (): Promise<Array<{ method: string; url: string; body: unknown }>> => {
    try {
      return JSON.parse(await fs.readFile(logPath, "utf-8"));
    } catch {
      return [];
    }
  };

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rollcall-"));
    logPath = path.join(tmpDir, "requests.json");

    // Write the mock curl executable
    const curlPath = path.join(tmpDir, "curl");
    await fs.writeFile(curlPath, mockCurlSource(logPath), { mode: 0o755 });
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await fs.writeFile(logPath, "[]");
  });

  // -------------------------------------------------------------------------
  // Unit test: agent-rollcall-probe.sh
  // -------------------------------------------------------------------------

  it("unit: probe script creates an issue with the correct title, description, assignee, and parent", async () => {
    const { stdout } = await exec(PROBE_SCRIPT, [
      "--agent-id",   "agent-abc",
      "--agent-name", "Natasha",
      "--parent",     "parent-uuid-123",
    ], { env: baseEnv() });

    // First line of stdout is the identifier
    const identifier = stdout.split("\n")[0].trim();
    expect(identifier).toBe("LINAA-42");

    const log = await readLog();
    expect(log).toHaveLength(1);

    const req = log[0] as any;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/issues");
    expect(req.body.title).toBe("Rollcall Probe - Natasha");
    expect(req.body.description).toContain("agent-rollcall");
    expect(req.body.description).toContain("done");
    expect(req.body.assigneeAgentId).toBe("agent-abc");
    expect(req.body.parentId).toBe("parent-uuid-123");
    expect(req.body.originKind).toBe("rollcall_probe");
  });

  it("unit: probe script fails without required args", async () => {
    await expect(
      exec(PROBE_SCRIPT, ["--agent-id", "x"], { env: baseEnv() })
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Integration test: full two-agent rollcall
  // -------------------------------------------------------------------------

  it("integration: rollcall creates probes, polls them, and produces a results table comment", async () => {
    const env = baseEnv();

    // Step 3: create probe for Natasha (responsive)
    const { stdout: natOut } = await exec(PROBE_SCRIPT, [
      "--agent-id",   "agent-natasha",
      "--agent-name", "Natasha",
      "--parent",     "rollcall-issue-uuid",
    ], { env });
    const natId = natOut.split("\n")[0].trim(); // LINAA-42

    // Step 3: create probe for Stark (will time out)
    const { stdout: starkOut } = await exec(PROBE_SCRIPT, [
      "--agent-id",   "agent-stark",
      "--agent-name", "Stark",
      "--parent",     "rollcall-issue-uuid",
    ], { env });
    const starkId = starkOut.split("\n")[0].trim(); // LINAA-43

    expect(natId).toBe("LINAA-42");
    expect(starkId).toBe("LINAA-43");

    // Step 4: poll each — LINAA-42 returns "done", LINAA-43 returns "in_progress"
    // Use a 5s timeout with 1s interval so LINAA-42 succeeds on first attempt
    // and LINAA-43 times out (poll script checks deadline before first attempt
    // if the process takes >timeout seconds, but with 5s there's room).
    let natStatus = "✅ responsive";
    let natLatency = "0s";
    try {
      const { stdout: pollOut } = await exec(POLL_SCRIPT, [natId, "30", "1"], { env });
      const latLine = pollOut.split("\n").find(l => l.startsWith("elapsed="));
      natLatency = latLine ? `${latLine.split("=")[1]}s` : "?s";
    } catch {
      natStatus = "❌ unresponsive (timeout)";
      natLatency = "—";
    }

    let starkStatus = "✅ responsive";
    let starkLatency = "0s";
    try {
      // 1s timeout — mock keeps returning in_progress, so this will timeout
      const { stdout: pollOut } = await exec(POLL_SCRIPT, [starkId, "1", "1"], { env });
      const latLine = pollOut.split("\n").find(l => l.startsWith("elapsed="));
      starkLatency = latLine ? `${latLine.split("=")[1]}s` : "?s";
    } catch {
      starkStatus = "❌ unresponsive (timeout)";
      starkLatency = "—";
    }

    expect(natStatus).toBe("✅ responsive");
    expect(starkStatus).toBe("❌ unresponsive (timeout)");

    // Step 5: post results table
    const table = [
      "## Rollcall Results",
      "",
      "| Agent | Probe | Status | Latency |",
      "|---|---|---|---|",
      `| Natasha | [${natId}](/${natId}) | ${natStatus} | ${natLatency} |`,
      `| Stark   | [${starkId}](/${starkId}) | ${starkStatus} | ${starkLatency} |`,
    ].join("\n");

    // agent-comment.sh takes positional args: <issue-ref> <body>
    await exec(COMMENT_SCRIPT, ["rollcall-issue-uuid", table], { env });

    const log = await readLog();

    // Should have: 2 POSTs (create issues) + polls + 1 GET (comment.sh resolves UUID-style ref via GET /api/issues/<id>)
    // rollcall-issue-uuid is a UUID (not identifier pattern), so no GET resolution
    const commentReq = log.find((r: any) => r.method === "POST" && r.url.includes("/comments"));
    expect(commentReq).toBeDefined();

    const commentBody = (commentReq as any).body.body as string;
    expect(commentBody).toContain("Natasha");
    expect(commentBody).toContain("Stark");
    expect(commentBody).toContain("LINAA-42");
    expect(commentBody).toContain("LINAA-43");
    expect(commentBody).toContain("✅ responsive");
    expect(commentBody).toContain("❌ unresponsive (timeout)");
  });
});
