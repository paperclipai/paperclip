import { describe, expect, it } from "vitest";
import { createEvidenceExtractorService, extractEvidenceCandidates } from "../evidence-extractors.js";
import { createValidatorService } from "../validators.js";
import type { EvidenceExtractionInput } from "../evidence-extractors.js";

function input(text: string, overrides: Partial<EvidenceExtractionInput> = {}): EvidenceExtractionInput {
  return {
    companyId: "company-1",
    runId: "run-1",
    issueId: "issue-1",
    agentId: "agent-1",
    laneKey: "default",
    sourceKind: "run",
    sourceId: "event-1",
    text,
    ...overrides,
  };
}

function byType(text: string, type: string) {
  return extractEvidenceCandidates(input(text)).filter((item) => item.type === type);
}

describe("autonomy evidence extractors", () => {
  it("extracts commit hashes only as pending candidate evidence", () => {
    const candidates = byType("Implemented in commit a1b2c3d4e5f678901234567890abcdef12345678", "commit");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: "commit",
      title: "Candidate commit a1b2c3d4e5f6",
      uri: "commit:a1b2c3d4e5f678901234567890abcdef12345678",
      payload: {
        commitSha: "a1b2c3d4e5f678901234567890abcdef12345678",
        validationState: "pending",
      },
    });
  });

  it("extracts test and build commands only when nearby result text exists", () => {
    const candidates = extractEvidenceCandidates(
      input(`
Ran checks:
$ pnpm --filter @paperclipai/server test -- autonomy-kernel
PASS  server/src/services/autonomy-kernel/__tests__/evidence-extractors.test.ts

$ pnpm build
exit code 0

$ pnpm lint
      `),
    );

    expect(candidates.map((item) => item.type)).toEqual(["test_run", "build"]);
    expect(candidates[0]?.payload).toMatchObject({
      command: "pnpm --filter @paperclipai/server test -- autonomy-kernel",
      claimedResult: "PASS",
      validationState: "pending",
    });
    expect(candidates[1]?.payload).toMatchObject({ command: "pnpm build", claimedResult: "exit code 0" });
  });

  it("extracts document refs, work product refs, URLs, and screenshots", () => {
    const candidates = extractEvidenceCandidates(
      input(`
Published [kernel plan](doc/plans/kernel.md) and artifact: dist/report.json
See https://example.com/health for the API check.
Screenshot: ui/screenshots/autonomy-pass.png
Image URL: https://cdn.example.com/result.webp
      `),
    );

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "document", uri: "doc/plans/kernel.md", payload: expect.objectContaining({ path: "doc/plans/kernel.md" }) }),
        expect.objectContaining({ type: "work_product", uri: "dist/report.json", payload: expect.objectContaining({ reference: "dist/report.json" }) }),
        expect.objectContaining({ type: "external_api_check", uri: "https://example.com/health" }),
        expect.objectContaining({ type: "screenshot", uri: "ui/screenshots/autonomy-pass.png" }),
        expect.objectContaining({ type: "screenshot", uri: "https://cdn.example.com/result.webp" }),
      ]),
    );
  });

  it("extracts approval decisions and blocker owner/action from comments", () => {
    const candidates = extractEvidenceCandidates(
      input(
        `Approval approved by Hugh for production deploy.\nBlocked by QA Lead: rerun on physical device and attach logs.`,
        { sourceKind: "comment", sourceId: "comment-1" },
      ),
    );

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval_decision",
          sourceType: "issue",
          sourceId: "comment-1",
          payload: expect.objectContaining({ decision: "approved", approver: "Hugh for production deploy" }),
        }),
        expect.objectContaining({
          type: "blocked_dependency",
          payload: expect.objectContaining({ owner: "QA Lead", unblockAction: "rerun on physical device and attach logs." }),
        }),
      ]),
    );
  });

  it("keeps extraction deterministic and conservative for status-only prose", () => {
    const candidates = extractEvidenceCandidates(input("I made progress and will run tests later. No artifacts yet."));

    expect(candidates).toEqual([]);
  });

  it("exposes the extractor through the validator service shell without validation", () => {
    const standalone = createEvidenceExtractorService();
    const validators = createValidatorService({} as never);

    expect(standalone.extractEvidenceCandidates(input("Build: pnpm build succeeded"))).toEqual([
      expect.objectContaining({ type: "build", payload: expect.objectContaining({ validationState: "pending" }) }),
    ]);
    expect(validators.evidenceExtractors.extractEvidenceCandidates(input("Tests: pnpm test passed"))).toEqual([
      expect.objectContaining({ type: "test_run", payload: expect.objectContaining({ validationState: "pending" }) }),
    ]);
  });
});
