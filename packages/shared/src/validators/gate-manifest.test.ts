import { describe, expect, it } from "vitest";
import {
  GATE_MANIFEST_DOCUMENT_KEY,
  evaluateGateManifestCompletion,
  formatGateManifestDocumentBody,
  gateManifestSchema,
  parseGateManifestDocumentBody,
} from "../index.js";

describe("gate manifest validators", () => {
  const validManifest = {
    version: 1,
    gates: [
      {
        id: "implementation",
        type: "implementation",
        title: "Implement the itinerary shelf fix",
        ownerAgentName: "fixer",
        issueId: "11111111-1111-4111-8111-111111111111",
        status: "passed",
        requiredEvidence: ["commit", "focused_tests"],
      },
      {
        id: "release",
        type: "release",
        title: "Promote the verified fix",
        ownerAgentName: "release-engineer",
        status: "pending",
      },
      {
        id: "production-smoke",
        type: "production_smoke",
        title: "Smoke /belly-trip and /trips in production",
        ownerAgentName: "watcher",
        status: "pending",
        blockedByGateIds: ["release"],
      },
    ],
  } as const;

  it("parses strict gate manifests with default parent completion policy", () => {
    const parsed = gateManifestSchema.parse(validManifest);

    expect(GATE_MANIFEST_DOCUMENT_KEY).toBe("gate_manifest");
    expect(parsed.donePolicy).toBe("all_required_gates_passed");
    expect(parsed.gates[0]?.status).toBe("passed");
  });

  it("rejects duplicate gate ids and dangling gate blockers", () => {
    const duplicateId = gateManifestSchema.safeParse({
      version: 1,
      gates: [
        { id: "qa", type: "qa", title: "QA", status: "pending" },
        { id: "qa", type: "qa", title: "QA again", status: "pending" },
      ],
    });
    const danglingBlocker = gateManifestSchema.safeParse({
      version: 1,
      gates: [
        {
          id: "production-smoke",
          type: "production_smoke",
          title: "Smoke production",
          status: "pending",
          blockedByGateIds: ["missing-release"],
        },
      ],
    });

    expect(duplicateId.success).toBe(false);
    expect(danglingBlocker.success).toBe(false);
  });

  it("formats and parses gate manifest documents deterministically", () => {
    const body = formatGateManifestDocumentBody(validManifest);
    const parsed = parseGateManifestDocumentBody(body);

    expect(body).toMatch(/"version": 1/);
    expect(body.endsWith("\n")).toBe(true);
    expect(parsed).toEqual(gateManifestSchema.parse(validManifest));
  });

  it("requires structured release and production smoke evidence before completion", () => {
    const manifest = gateManifestSchema.parse({
      version: 1,
      gates: [
        {
          id: "release",
          type: "release",
          title: "Deploy to production",
          status: "passed",
          requiredEvidence: ["commit", "deploy_url"],
        },
        {
          id: "production-smoke",
          type: "production_smoke",
          title: "Smoke production",
          status: "passed",
          requiredEvidence: ["production_url", "screenshot_or_artifact"],
          blockedByGateIds: ["release"],
        },
      ],
    });

    const missing = evaluateGateManifestCompletion(manifest, { version: 1, records: [] });

    expect(missing.incompleteGateIds).toEqual(["release", "production-smoke"]);
    expect(missing.gateEvidenceFailures).toEqual([
      { gateId: "release", missingEvidence: ["commit", "deploy_url"] },
      { gateId: "production-smoke", missingEvidence: ["production_url", "screenshot_or_artifact"] },
    ]);

    const complete = evaluateGateManifestCompletion(manifest, {
      version: 1,
      records: [
        {
          id: "release-1",
          gateId: "release",
          gateType: "release",
          status: "passed",
          timestamp: "2026-05-06T00:00:00.000Z",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          commands: [],
          urls: [{ label: "Deploy run", url: "https://github.com/paperclipai/paperclip/actions/runs/1" }],
          screenshots: [],
          artifacts: [],
        },
        {
          id: "prod-smoke-1",
          gateId: "production-smoke",
          gateType: "production_smoke",
          status: "passed",
          timestamp: "2026-05-06T00:05:00.000Z",
          commands: [],
          urls: [{ label: "Production /trips", url: "https://app.example.com/trips" }],
          screenshots: [{ label: "desktop", path: ".paperclip/artifacts/prod-trips.png" }],
          artifacts: [],
        },
      ],
    });

    expect(complete.incompleteGateIds).toEqual([]);
    expect(complete.gateEvidenceFailures).toEqual([]);
  });
});
