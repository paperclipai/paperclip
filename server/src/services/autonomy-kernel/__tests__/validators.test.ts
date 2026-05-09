import { describe, expect, it, vi } from "vitest";
import { createEvidenceValidatorRegistry, createValidatorService } from "../validators.js";
import type { ValidatorEvidenceCandidate } from "../validators.js";

function candidate(overrides: Partial<ValidatorEvidenceCandidate>): ValidatorEvidenceCandidate {
  return {
    type: "commit",
    title: "candidate",
    summary: null,
    uri: null,
    payload: {},
    sourceType: "heartbeat_run_event",
    sourceId: "event-1",
    ...overrides,
  };
}

describe("autonomy evidence validator registry", () => {
  it("validates commit evidence only through an injected repository verifier", async () => {
    const verifyCommit = vi.fn(({ sha }) => ({ exists: sha === "a1b2c3d4e5f678901234567890abcdef12345678" }));
    const registry = createEvidenceValidatorRegistry({ adapters: { verifyCommit } });

    await expect(
      registry.validateEvidenceCandidate(
        candidate({
          type: "commit",
          uri: "commit:a1b2c3d4e5f678901234567890abcdef12345678",
          payload: { commitSha: "a1b2c3d4e5f678901234567890abcdef12345678" },
        }),
      ),
    ).resolves.toMatchObject({
      verdict: "accepted",
      validatorName: "commit-evidence-validator",
      reason: "Accepted commit evidence: repository verifier confirmed the commit exists.",
    });
    expect(verifyCommit).toHaveBeenCalledWith(expect.objectContaining({ sha: "a1b2c3d4e5f678901234567890abcdef12345678" }));

    await expect(
      createEvidenceValidatorRegistry().validateEvidenceCandidate(candidate({ type: "commit", payload: { commitSha: "a1b2c3d" } })),
    ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected commit evidence: no repository verifier was supplied." });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "commit", payload: { commitSha: "not-a-sha" } })),
    ).resolves.toMatchObject({
      verdict: "rejected",
      reason: "Rejected commit evidence: candidate does not contain a valid 7-40 character hex commit id.",
    });
  });

  it("accepts test and build evidence with trusted success metadata and rejects claim-only commands", async () => {
    const registry = createEvidenceValidatorRegistry();

    await expect(
      registry.validateEvidenceCandidate(
        candidate({
          type: "test_run",
          payload: { command: "pnpm test", exitCode: 0, resultText: "PASS src/services/autonomy-kernel/__tests__/validators.test.ts" },
        }),
      ),
    ).resolves.toMatchObject({ verdict: "accepted", reason: "Accepted test_run evidence: trusted result metadata indicates success." });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "build", payload: { command: "pnpm build", status: "succeeded" } })),
    ).resolves.toMatchObject({ verdict: "accepted", reason: "Accepted build evidence: trusted result metadata indicates success." });

    await expect(
      registry.validateEvidenceCandidate(
        candidate({ type: "test_run", payload: { command: "pnpm test", claimedResult: "passed", matchedText: "Tests passed" } }),
      ),
    ).resolves.toMatchObject({
      verdict: "rejected",
      reason: "Rejected test_run evidence: command/result prose is claim-only and lacks trusted exit status or result output.",
    });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "build", payload: { command: "pnpm build", exitCode: 1, resultText: "failed" } })),
    ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected build evidence: trusted result metadata does not indicate success." });
  });

  it("validates file, artifact, and screenshot evidence through an injected file verifier", async () => {
    const verifyFile = vi.fn(({ path }) => ({ exists: path !== "missing/report.json", contentType: path.endsWith(".png") ? "image/png" : "application/json" }));
    const registry = createEvidenceValidatorRegistry({ adapters: { verifyFile } });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "work_product", uri: "dist/report.json", payload: { reference: "dist/report.json" } })),
    ).resolves.toMatchObject({ verdict: "accepted", reason: "Accepted work_product evidence: verifier confirmed the artifact exists." });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "document", uri: "missing/report.json", payload: { path: "missing/report.json" } })),
    ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected document evidence: file verifier did not confirm existence." });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "screenshot", uri: "screens/pass.png", payload: { path: "screens/pass.png" } })),
    ).resolves.toMatchObject({ verdict: "accepted", reason: "Accepted screenshot evidence: verifier confirmed the artifact exists." });

    await expect(
      createEvidenceValidatorRegistry().validateEvidenceCandidate(candidate({ type: "screenshot", uri: "screens/pass.png", payload: { path: "screens/pass.png" } })),
    ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected screenshot evidence: no file verifier was supplied." });
  });

  it("validates URL evidence through an injected URL verifier without doing live HTTP in tests", async () => {
    const verifyUrl = vi.fn(({ url }) => ({ status: url.includes("ok") ? 204 : 503, contentType: url.endsWith(".webp") ? "image/webp" : "application/json" }));
    const registry = createEvidenceValidatorRegistry({ adapters: { verifyUrl } });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "external_api_check", uri: "https://example.com/ok", payload: { url: "https://example.com/ok" } })),
    ).resolves.toMatchObject({ verdict: "accepted", reason: "Accepted external_api_check evidence: URL verifier confirmed a successful status.", validatorPayload: { status: 204 } });
    expect(verifyUrl).toHaveBeenCalledTimes(1);

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "external_api_check", uri: "https://example.com/down", payload: { url: "https://example.com/down" } })),
    ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected external_api_check evidence: URL verifier did not confirm a successful status.", validatorPayload: { status: 503 } });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "screenshot", uri: "https://cdn.example.com/ok.webp", payload: { url: "https://cdn.example.com/ok.webp" } })),
    ).resolves.toMatchObject({ verdict: "accepted", reason: "Accepted screenshot evidence: URL verifier confirmed a successful status." });
  });

  it("requires audited decision metadata for approvals instead of trusting approval prose", async () => {
    const verifyApprovalDecision = vi.fn(({ decisionId }) => ({ ok: decisionId === "decision-1" }));
    const registry = createEvidenceValidatorRegistry({ adapters: { verifyApprovalDecision } });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "approval_decision", payload: { decision: "approved", decisionId: "decision-1", matchedText: "approved by Hugh" } })),
    ).resolves.toMatchObject({ verdict: "accepted", reason: "Accepted approval_decision evidence: audited approval decision metadata is present.", validatorPayload: { decision: "approved" } });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "approval_decision", payload: { decision: "approved", matchedText: "approved by Hugh" } })),
    ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected approval_decision evidence: approval requires audited decision metadata with a decision id." });
  });

  it("requires blocker evidence to include concrete owner and concrete next action", async () => {
    const registry = createEvidenceValidatorRegistry();

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "blocked_dependency", payload: { owner: "QA Lead", unblockAction: "rerun on a physical device and attach logs" } })),
    ).resolves.toMatchObject({ verdict: "accepted", reason: "Accepted blocker evidence: concrete owner and next action are present." });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "blocked_dependency", payload: { owner: "someone", unblockAction: "fix it" } })),
    ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected blocker evidence: blocker must include a concrete owner." });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "blocked_dependency", payload: { owner: "Platform Team", unblockAction: "todo" } })),
    ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected blocker evidence: blocker must include a concrete next action." });
  });

  it("returns explicit rejected verdicts for unsupported types and does not leak secret payload values in reasons", async () => {
    const registry = createEvidenceValidatorRegistry();
    const result = await registry.validateEvidenceCandidate(candidate({ type: "run_log", payload: { token: "sk-secret-value-that-must-not-appear", note: "looks good" } }));

    expect(result).toMatchObject({
      verdict: "rejected",
      validatorName: "unsupported-evidence-validator",
      reason: "Rejected run_log evidence: no validator is registered for this evidence type.",
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret-value-that-must-not-appear");
  });

  it("exposes extractors and validation registry through the validator service", async () => {
    const service = createValidatorService({} as never, {
      adapters: { verifyCommit: () => ({ exists: true }) },
    });

    expect(
      service.evidenceExtractors.extractEvidenceCandidates({
        companyId: "company-1",
        runId: "run-1",
        issueId: "issue-1",
        agentId: "agent-1",
        laneKey: "default",
        sourceKind: "run",
        sourceId: "event-1",
        text: "",
      }),
    ).toEqual([]);
    await expect(service.validateEvidenceCandidate(candidate({ type: "commit", payload: { commitSha: "a1b2c3d" } }))).resolves.toMatchObject({ verdict: "accepted" });
  });
});
