import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execute } from "./execute.js";
import { openKb, upsertPatterns } from "./kb.js";
import { SEED_PATTERNS } from "./match.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function makeCtx(overrides: {
  kbPath: string;
  auditPath: string;
  issueId?: string;
  dryRun?: boolean;
}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "Deflector", adapterType: "deflector_local" } as never,
    runtime: {} as never,
    config: {
      kbPath: overrides.kbPath,
      auditPath: overrides.auditPath,
      dryRun: overrides.dryRun ?? false,
      apiBaseUrl: "http://test.local",
    },
    context: {
      paperclipIssue: overrides.issueId
        ? { id: overrides.issueId, identifier: "AIP-1", title: "Recover stalled issue AIP-9" }
        : undefined,
    },
    onLog: async () => {},
    authToken: "test-token",
  };
}

describe("execute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves when pattern matches and origin is terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deflector-ex-"));
    const kbPath = join(dir, "kb.sqlite");
    const auditPath = join(dir, "audit.jsonl");
    const db = openKb(kbPath);
    upsertPatterns(db, SEED_PATTERNS);
    db.close();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/issues/issue-1") && (!init || init.method === "GET" || !init.method)) {
        return new Response(
          JSON.stringify({
            id: "issue-1",
            identifier: "AIP-1",
            title: "Recover stalled issue AIP-9",
            originKind: "stranded_issue_recovery",
            originId: "origin-1",
            companyId: "co-1",
            status: "todo",
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/api/issues/origin-1")) {
        return new Response(JSON.stringify({ id: "origin-1", status: "done" }), { status: 200 });
      }
      if (u.endsWith("/api/issues/issue-1") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await execute(makeCtx({ kbPath, auditPath, issueId: "issue-1" }));
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("stranded_issue_recovery_source_terminal");
      const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
      expect(patchCalls.length).toBe(1);
      const body = JSON.parse(String(patchCalls[0]![1]!.body));
      expect(body.status).toBe("done");
      expect(body.comment).toContain("stranded_issue_recovery_source_terminal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases assignment when no pattern matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deflector-ex-"));
    const kbPath = join(dir, "kb.sqlite");
    const auditPath = join(dir, "audit.jsonl");
    const db = openKb(kbPath);
    upsertPatterns(db, SEED_PATTERNS);
    db.close();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/api/issues/") && (!init || !init.method || init.method === "GET")) {
          return new Response(
            JSON.stringify({
              id: "issue-2",
              identifier: "AIP-2",
              title: "Investigate conversion drop",
              originKind: "manual",
              originId: null,
              companyId: "co-1",
              status: "todo",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    try {
      const result = await execute(
        makeCtx({
          kbPath,
          auditPath,
          issueId: "issue-2",
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("pass-through");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
