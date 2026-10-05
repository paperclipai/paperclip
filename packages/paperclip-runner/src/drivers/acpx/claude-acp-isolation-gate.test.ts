// Layer 2 of doc/plans/2026-10-03-claude-agent-acp-0.85.1-patch-report.md's
// Verification section: a behavioural test with options capture. Layer 1
// (test/acpx-codex-package-contract.test.mjs → "the installed Claude ACP
// artifact actually carries the isolation gates") proves the gate's source
// *shape*. This file proves the gate's *behaviour*: it runs the real,
// installed, patched `@agentclientprotocol/claude-agent-acp` package against
// a mocked `@anthropic-ai/claude-agent-sdk` `query()` that records the
// options object it was called with and then throws, so every row below
// observes the exact options the SDK would have received without ever
// spawning the CLI.
//
// Mutation check (run manually, not part of CI): with the isolation gate
// removed from the installed artifact (e.g. temporarily restoring a
// pre-patch `acp-agent.js`), every "isolated" row below must fail. A gate
// test that still passes against unpatched code is worthless. See the plan
// doc's Verification section, item 2.
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const ISOLATION_ENV = "PAPERCLIP_ACPX_ISOLATED_CONTEXT";
const BRIDGE_URL_ENV = "PAPERCLIP_ACPX_TASK_TOOL_BRIDGE_URL";
const BRIDGE_URL = "https://paperclip-task-bridge.test/mcp";
const NON_BRIDGE_URL = "https://not-the-task-bridge.test/mcp";
const BRIDGE_TOOLS = [
  "paperclip_finish",
  "paperclip_block",
  "read_current_wake_comments",
  "request_human_input",
].map((tool) => `mcp__paperclip__${tool}`);

const CANARY_MCP_SERVERS = {
  canary: { type: "stdio", command: "/bin/true", args: [], env: {} },
};
const META_ALLOWED_TOOLS = ["Bash"];

let sdkEntryPath: string;
let actualSdk: Record<string, unknown>;
let capturedOptions: Record<string, any> | undefined;

function stubAcpClient() {
  const resolved = async () => undefined;
  return {
    sessionUpdate: vi.fn(resolved),
    requestPermission: vi.fn(resolved),
    readTextFile: vi.fn(resolved),
    writeTextFile: vi.fn(resolved),
    createElicitation: vi.fn(resolved),
    completeElicitation: vi.fn(resolved),
    extNotification: vi.fn(resolved),
  };
}

function stubLogger() {
  return { log: () => {}, error: () => {}, warn: () => {}, info: () => {} };
}

const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined) {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const tempDirs: string[] = [];
async function freshCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-acp-isolation-gate-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  const requireFromTest = createRequire(import.meta.url);
  const acpPackageJsonPath = requireFromTest.resolve(
    "@agentclientprotocol/claude-agent-acp/package.json",
  );
  // Resolve the SDK the same way the installed claude-agent-acp package
  // resolves it (pnpm's strict per-package node_modules), not however this
  // test file's own node_modules happens to see it — paperclip-runner does
  // not (and must not) depend on @anthropic-ai/claude-agent-sdk directly.
  sdkEntryPath = createRequire(acpPackageJsonPath).resolve(
    "@anthropic-ai/claude-agent-sdk",
  );
  actualSdk = await vi.importActual(sdkEntryPath);

  // Keep every real export (resolveSettings, getSessionMessages, etc. — the
  // rest of acp-agent.js and settings.js depend on them) and replace only
  // `query`, which is the one real entry point this test must never reach.
  vi.doMock(sdkEntryPath, () => ({
    ...actualSdk,
    query: (arg: { options: Record<string, unknown> }) => {
      capturedOptions = arg.options as Record<string, any>;
      throw new Error(
        "claude-acp-isolation-gate test: intentional short-circuit before CLI spawn",
      );
    },
  }));
});

beforeEach(() => {
  capturedOptions = undefined;
});

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Row {
  name: string;
  isolated: boolean;
  bridgeUrlEnv: string | undefined;
  mcpServers: unknown[];
  assert: (options: Record<string, any>) => void;
}

const ROWS: Row[] = [
  {
    name: "isolated + paperclip http matching BRIDGE_URL -> settingSources pinned, canary stripped, task-bridge tools only",
    isolated: true,
    bridgeUrlEnv: BRIDGE_URL,
    mcpServers: [
      { name: "paperclip", type: "http", url: BRIDGE_URL, headers: [] },
    ],
    assert(options) {
      expect(options.settingSources).toEqual(["user"]);
      expect(options.mcpServers).not.toHaveProperty("canary");
      expect(options.allowedTools).toEqual(BRIDGE_TOOLS);
    },
  },
  {
    name: "isolated + paperclip http NOT matching BRIDGE_URL -> allowedTools empty",
    isolated: true,
    bridgeUrlEnv: BRIDGE_URL,
    mcpServers: [
      { name: "paperclip", type: "http", url: NON_BRIDGE_URL, headers: [] },
    ],
    assert(options) {
      expect(options.settingSources).toEqual(["user"]);
      expect(options.mcpServers).not.toHaveProperty("canary");
      expect(options.allowedTools).toEqual([]);
    },
  },
  {
    name: "isolated + paperclip stdio -> allowedTools empty",
    isolated: true,
    bridgeUrlEnv: BRIDGE_URL,
    mcpServers: [
      { name: "paperclip", command: "/bin/true", args: [], env: [] },
    ],
    assert(options) {
      expect(options.settingSources).toEqual(["user"]);
      expect(options.mcpServers).not.toHaveProperty("canary");
      expect(options.allowedTools).toEqual([]);
    },
  },
  {
    name: "isolated + no ACP mcpServers + BRIDGE_URL unset -> allowedTools empty (no undefined === undefined pass)",
    isolated: true,
    bridgeUrlEnv: undefined,
    mcpServers: [],
    assert(options) {
      expect(options.settingSources).toEqual(["user"]);
      expect(options.mcpServers).not.toHaveProperty("canary");
      expect(options.allowedTools).toEqual([]);
    },
  },
  {
    name: "isolation unset -> upstream behaviour: canary present, settingSources from meta (proves the test discriminates)",
    isolated: false,
    bridgeUrlEnv: BRIDGE_URL,
    mcpServers: [
      { name: "paperclip", type: "http", url: BRIDGE_URL, headers: [] },
    ],
    assert(options) {
      expect(options.settingSources).toEqual(["user", "project", "local"]);
      expect(options.mcpServers).toHaveProperty("canary");
      expect(options.allowedTools).toEqual(META_ALLOWED_TOOLS);
    },
  },
];

async function probe(
  row: Pick<Row, "isolated" | "bridgeUrlEnv" | "mcpServers">,
  via: "newSession" | "resumeSession" | "loadSession",
): Promise<Record<string, any>> {
  setEnv(ISOLATION_ENV, row.isolated ? "1" : undefined);
  setEnv(BRIDGE_URL_ENV, row.bridgeUrlEnv);
  // The isolation env vars are snapshotted into module-level consts at
  // import time (the managed-policy hardening fix). A fresh module
  // evaluation is the only way to observe a different snapshot.
  vi.resetModules();
  const { ClaudeAcpAgent } = (await import(
    "@agentclientprotocol/claude-agent-acp"
  )) as { ClaudeAcpAgent: new (client: unknown, logger: unknown) => any };
  const agent = new ClaudeAcpAgent(stubAcpClient(), stubLogger());
  const cwd = await freshCwd();
  const meta = {
    claudeCode: {
      options: {
        settingSources: ["user", "project", "local"],
        mcpServers: CANARY_MCP_SERVERS,
        allowedTools: META_ALLOWED_TOOLS,
      },
    },
  };

  if (via === "newSession") {
    await expect(
      agent.newSession({ cwd, mcpServers: row.mcpServers, _meta: meta }),
    ).rejects.toThrow();
  } else if (via === "resumeSession") {
    await expect(
      agent.resumeSession({
        sessionId: crypto.randomUUID(),
        cwd,
        mcpServers: row.mcpServers,
        _meta: meta,
      }),
    ).rejects.toThrow();
  } else {
    await expect(
      agent.loadSession({
        sessionId: crypto.randomUUID(),
        cwd,
        mcpServers: row.mcpServers,
        _meta: meta,
      }),
    ).rejects.toThrow();
  }

  expect(capturedOptions, "query() must have been called and captured").toBeDefined();
  return capturedOptions!;
}

describe("claude-agent-acp 0.85.1 isolation gate (options capture)", () => {
  for (const row of ROWS) {
    it(`newSession: ${row.name}`, async () => {
      const options = await probe(row, "newSession");
      row.assert(options);
    });
  }

  // Load and resume rebuild the Query through the same createSession path
  // (see the plan doc's "(a) What changed upstream" — "Rebuild-on-resume").
  // Only row 1 (the straightforward isolated case) is repeated here; the
  // mcpServers-matching logic itself is already exhaustively covered above.
  it("resumeSession: isolated + paperclip http matching BRIDGE_URL -> settingSources pinned, canary stripped, task-bridge tools only", async () => {
    const options = await probe(ROWS[0]!, "resumeSession");
    ROWS[0]!.assert(options);
  });

  it("loadSession: isolated + paperclip http matching BRIDGE_URL -> settingSources pinned, canary stripped, task-bridge tools only", async () => {
    const options = await probe(ROWS[0]!, "loadSession");
    ROWS[0]!.assert(options);
  });
});
