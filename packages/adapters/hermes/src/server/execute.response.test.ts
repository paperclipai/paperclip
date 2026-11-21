import { describe, expect, it, vi } from "vitest";

const HERMES_STDOUT = [
  "│ apps/web/src/page.tsx │",
  "│ @@ -1,2 +1,3 @@",
  "\x1b[2m│\x1b[0m \x1b[32m+const x = 1;\x1b[0m",
  "Implemented the page and ran the tests.",
  "",
  "session_id: 20261103_120000_abcdef",
].join("\n");

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: HERMES_STDOUT,
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";

describe("hermes_local execute — response cleaning", () => {
  it("drops inline diff gutter lines from the summary and result", async () => {
    const ctx = {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async () => undefined),
    };

    const result = await execute(ctx as unknown as Parameters<typeof execute>[0]);

    expect(result.summary).toBe("Implemented the page and ran the tests.");
    expect((result.resultJson as { result: string }).result).toBe(
      "Implemented the page and ran the tests.",
    );
  });
});
