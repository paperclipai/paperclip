import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptanceCriteriaChangedAfterRunStart,
  commentSignalsAcceptanceCriteriaChange,
  countCloseEvidenceLocalFiles,
  selectFreshestCloseGateRun,
} from "./issue-close-evidence.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("countCloseEvidenceLocalFiles", () => {
  it("counts files from a configured relocated work-products root", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-close-evidence-"));
    const relocatedRoot = path.join(home, "external-work-products", "company-1");
    const issueRoot = path.join(relocatedRoot, "TSMC-18953");
    delete process.env.PAPERCLIP_WORK_PRODUCTS_DIR;
    delete process.env.PAPERCLIP_COMPANY_ROOT;
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "instance-a";

    const companyConfigDir = path.join(home, "instances", "instance-a", "companies", "company-1");
    fs.mkdirSync(companyConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(companyConfigDir, "config.json"),
      `${JSON.stringify({ workProductsRoot: relocatedRoot }, null, 2)}\n`,
      "utf8",
    );
    fs.mkdirSync(path.join(issueRoot, "nested"), { recursive: true });
    fs.writeFileSync(path.join(issueRoot, "a.txt"), "a\n", "utf8");
    fs.writeFileSync(path.join(issueRoot, "nested", "b.txt"), "b\n", "utf8");

    await expect(
      countCloseEvidenceLocalFiles("company-1", {
        mode: "evidence",
        evidenceTarget: 2,
        evidencePath: "TSMC-18953",
        artifactKind: "generated_media",
      }),
    ).resolves.toEqual({
      count: 2,
      localPath: issueRoot,
    });
  });
});

describe("selectFreshestCloseGateRun (TSMC-19840)", () => {
  const olderPack = {
    id: "run-pack",
    status: "succeeded",
    startedAt: "2026-08-05T10:50:00.000Z",
    createdAt: "2026-08-05T10:49:00.000Z",
  };
  const fresherActor = {
    id: "run-actor",
    status: "running",
    startedAt: "2026-08-05T12:00:00.000Z",
    createdAt: "2026-08-05T11:59:00.000Z",
  };

  it("prefers actor close-out when fresher than prior issue-scoped run", () => {
    expect(
      selectFreshestCloseGateRun({
        latestScoped: olderPack,
        actorRun: fresherActor,
      })?.id,
    ).toBe("run-actor");
  });

  it("keeps a newer issue-scoped run when actor is older", () => {
    expect(
      selectFreshestCloseGateRun({
        latestScoped: fresherActor,
        actorRun: olderPack,
      })?.id,
    ).toBe("run-actor");
  });

  it("returns actor alone when issue-scoped index misses contextSnapshot", () => {
    expect(
      selectFreshestCloseGateRun({
        latestScoped: null,
        actorRun: fresherActor,
      })?.id,
    ).toBe("run-actor");
  });

  it("returns shared identity once when actor is also latestScoped", () => {
    expect(
      selectFreshestCloseGateRun({
        latestScoped: fresherActor,
        actorRun: { ...fresherActor },
      })?.id,
    ).toBe("run-actor");
  });
});

describe("commentSignalsAcceptanceCriteriaChange (TSMC-19840)", () => {
  it("does not treat bare board Acceptance: delivery receipts as AC mutation", () => {
    expect(commentSignalsAcceptanceCriteriaChange("Acceptance: NEW providerMessageId abc-123")).toBe(false);
    expect(commentSignalsAcceptanceCriteriaChange("acceptance: delivered pack v3")).toBe(false);
    expect(commentSignalsAcceptanceCriteriaChange("Note acceptance of the handoff.")).toBe(false);
  });

  it("detects stronger AC-edit signals", () => {
    expect(commentSignalsAcceptanceCriteriaChange("Updated acceptance criteria for the close path.")).toBe(true);
    expect(commentSignalsAcceptanceCriteriaChange("Please change the acceptance criteria before close.")).toBe(true);
    expect(commentSignalsAcceptanceCriteriaChange("## Acceptance Criteria\n- ship the fix")).toBe(true);
    expect(commentSignalsAcceptanceCriteriaChange("acceptanceCriteria were revised overnight")).toBe(true);
    expect(commentSignalsAcceptanceCriteriaChange("Rewrote acceptance for the pilot.")).toBe(true);
  });
});

describe("acceptanceCriteriaChangedAfterRunStart (TSMC-19840)", () => {
  const priorPackRunStartedAt = "2026-08-05T10:50:00.000Z";
  const boardAcceptanceAfterPrior = "2026-08-05T11:07:00.000Z";
  const boardAcceptanceLater = "2026-08-05T11:29:00.000Z";
  const freshCloseOutStartedAt = "2026-08-05T12:00:00.000Z";

  it("false-trips on prior pack run when board uses bare Acceptance: prose (legacy failure mode)", () => {
    const result = acceptanceCriteriaChangedAfterRunStart({
      runStartedAt: priorPackRunStartedAt,
      comments: [
        {
          authorType: "board",
          createdAt: boardAcceptanceAfterPrior,
          body: "Acceptance: NEW providerMessageId msg-1",
        },
        {
          authorType: "user",
          createdAt: boardAcceptanceLater,
          body: "Acceptance: NEW providerMessageId msg-2",
        },
      ],
    });
    // Detector tightened: bare Acceptance: must NOT count as AC mutation even vs prior run.
    expect(result).toEqual({ changed: false, source: null, changedAt: null });
  });

  it("allows a later assignee close-out run after board Acceptance: receipts (fixture)", () => {
    const result = acceptanceCriteriaChangedAfterRunStart({
      runStartedAt: freshCloseOutStartedAt,
      comments: [
        {
          authorType: "board",
          createdAt: boardAcceptanceAfterPrior,
          body: "Acceptance: NEW providerMessageId msg-1",
        },
        {
          authorType: "user",
          createdAt: boardAcceptanceLater,
          body: "Acceptance: NEW providerMessageId msg-2",
        },
        {
          authorType: "agent",
          createdAt: "2026-08-05T12:05:00.000Z",
          body: "Formal close-out verified.",
        },
      ],
    });
    expect(result.changed).toBe(false);
    expect(result.source).toBeNull();
  });

  it("still flags real acceptance-criteria edits after the close-out run starts", () => {
    const result = acceptanceCriteriaChangedAfterRunStart({
      runStartedAt: freshCloseOutStartedAt,
      comments: [
        {
          authorType: "board",
          createdAt: "2026-08-05T12:10:00.000Z",
          body: "Updated acceptance criteria: add force-done escape.",
        },
      ],
    });
    expect(result.changed).toBe(true);
    expect(result.source).toBe("comment");
    expect(result.changedAt).toBe("2026-08-05T12:10:00.000Z");
  });

  it("flags acceptance-criteria document updates after run start", () => {
    const result = acceptanceCriteriaChangedAfterRunStart({
      runStartedAt: freshCloseOutStartedAt,
      acceptanceCriteriaDocumentUpdatedAt: "2026-08-05T12:15:00.000Z",
    });
    expect(result).toEqual({
      changed: true,
      source: "document",
      changedAt: "2026-08-05T12:15:00.000Z",
    });
  });
});
