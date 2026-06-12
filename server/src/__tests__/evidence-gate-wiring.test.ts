import { describe, expect, it, vi } from "vitest";
import {
  runEvidenceGate,
  type EvidenceFetchResult,
} from "../services/evidence-gate-wiring.js";

const FRONTEND_DONE_WHEN = `## Done when\n- a\n- b\n- c\n`;

function frontendBody(): string {
  return [
    "![desktop](./shot_1440x900.png)",
    "![mobile](./shot_390x844.png)",
    "| Criterion | Status |",
    "|---|---|",
    "| a | ✅ |",
    "| b | ✅ |",
    "| c | ✅ |",
  ].join("\n");
}

describe("runEvidenceGate", () => {
  it("returns a pass record for a fully-evidenced frontend issue", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
        comments: [
          {
            body: frontendBody(),
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );
    const fixedNow = new Date("2026-05-11T22:00:00.000Z");
    const result = await runEvidenceGate(fetch, "issue-1", fixedNow);
    expect(fetch).toHaveBeenCalledWith("issue-1");
    expect(result.verdict).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.unlabeledFallback).toBe(false);
    expect(result.evaluatedAt).toBe("2026-05-11T22:00:00.000Z");
  });

  it("returns a block record when frontend evidence is missing", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
        comments: [
          {
            body: "claiming done",
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-2");
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "screenshot:1440x900",
        "screenshot:390x844",
        "checklist:done-when",
      ]),
    );
  });

  it("maps work-product `type` to evaluator `kind` (screenshot pickup)", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
        comments: [
          {
            body: "| a | ✅ |\n|---|---|\n| b | ✅ |\n| c | ✅ |\n| d | ✅ |",
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [
          { type: "screenshot", metadata: { viewport: "1440x900" }, status: "ok" },
          { type: "screenshot", metadata: { viewport: "390x844" }, status: "ok" },
        ],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-3");
    expect(result.verdict).toBe("pass");
    expect(result.evidenceFound).toEqual(
      expect.arrayContaining(["screenshot:1440x900", "screenshot:390x844"]),
    );
  });

  it("flags unlabeledFallback when the issue has no matching label", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "## Done when\n- something",
        labels: [{ name: "random" }],
        comments: [
          {
            body: "done",
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-4");
    expect(result.verdict).toBe("warn");
    expect(result.unlabeledFallback).toBe(true);
    expect(result.missing).toEqual(["checklist:done-when"]);
  });

  it("e2e-run with status='pass' satisfies the e2e-run shape (via status → result mapping)", async () => {
    // The wiring maps work_product.status → evaluator.result. A workproduct
    // with status: "pass" should satisfy `e2e-run` for a registry that
    // requires it. This is a sanity check that the mapping doesn't drop the
    // value or use the wrong field.
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "## Done when\n- e2e covers flow",
        labels: [{ name: "e2e-strict" }],
        comments: [
          {
            body: "ran the script",
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [
          { type: "e2e-run", metadata: null, status: "pass" },
        ],
      }),
    );
    // The default registry doesn't have an e2e-strict label; this test
    // therefore exercises the unlabeled-fallback path. e2e-run isn't a
    // required shape there, so result is `warn` (missing checklist) — what
    // we want to assert here is that the evidenceFound list DOES include
    // e2e-run, proving the wiring's status→result mapping worked.
    const result = await runEvidenceGate(fetch, "issue-5");
    expect(result.evidenceFound).toContain("e2e-run");
  });

  it("detects PR links in agent-authored QA/recovery evidence comments", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "## Done when\n- QA evidence exists",
        labels: [],
        comments: [
          {
            body: [
              "## QA recovery evidence",
              "- Implementation PR: https://github.com/Blockcast/Network-Operator-Portal/pull/319",
              "- Test output: Test Files  1 passed (1)",
              "| Criterion | Status | Evidence |",
              "|---|---|---|",
              "| QA evidence exists | [x] | qa-report |",
            ].join("\n"),
            authorAgentId: "qa-agent",
            authorUserId: null,
            createdAt: "2026-06-12T00:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-qa-only");
    expect(result.evidenceFound).toEqual(expect.arrayContaining(["pr-link", "test-output", "checklist:done-when"]));
  });

  it("propagates fetch failures back to the caller (no swallowing)", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => {
        throw new Error("DB explosion");
      },
    );
    await expect(runEvidenceGate(fetch, "issue-6")).rejects.toThrow(
      /DB explosion/,
    );
  });
});
