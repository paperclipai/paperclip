import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1, PluginNamespaceFence } from "../src/types.js";

const manifest = {
  id: "paperclip.test-conditional-issues",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Conditional Issues",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["issues.read", "issues.create", "issues.update"],
  entrypoints: { worker: "worker.js" },
} satisfies PaperclipPluginManifestV1;

const companyId = "company-1";

const fence: PluginNamespaceFence = {
  table: "serialized_lanes",
  lane: { lane_key: "phase-a2" },
  expected: { fence_token: "fence-1", generation: 7 },
};

function harnessWithFence() {
  const harness = createTestHarness({ manifest });
  harness.seed({
    namespaceFences: [
      {
        table: fence.table,
        lane: fence.lane,
        values: { fence_token: "fence-1", generation: 7 },
      },
    ],
  });
  return harness;
}

describe("typed conditional issue updates through the harness", () => {
  it("threads version from create and get into CAS without casts or hardcoded versions", async () => {
    const harness = harnessWithFence();

    const created = await harness.ctx.issues.create({
      companyId,
      title: "Lane work",
    });
    // `version` must be part of the returned type: this line fails to compile
    // (TS2339) if reads/writes ever go back to the unversioned Issue shape.
    expect(created.version).toBe(1);

    const fetched = await harness.ctx.issues.get(created.id, companyId);
    expect(fetched?.version).toBe(created.version);

    const applied = await harness.ctx.issues.updateConditional({
      issueId: created.id,
      companyId,
      patch: { title: "Lane work (applied)" },
      expectedVersion: created.version,
      namespaceFence: fence,
    });
    expect(applied).toMatchObject({ applied: true });
    if (!applied.applied) throw new Error("expected applied result");
    expect(applied.issue.version).toBe(created.version + 1);
    expect(applied.issue.title).toBe("Lane work (applied)");

    const replay = await harness.ctx.issues.updateConditional({
      issueId: created.id,
      companyId,
      patch: { title: "Must not apply" },
      expectedVersion: created.version,
      namespaceFence: fence,
    });
    expect(replay).toEqual({ applied: false, reason: "issue_version_mismatch" });

    const chained = await harness.ctx.issues.updateConditional({
      issueId: created.id,
      companyId,
      patch: { title: "Lane work (chained)" },
      expectedVersion: applied.issue.version,
      namespaceFence: fence,
    });
    expect(chained).toMatchObject({ applied: true, issue: { version: applied.issue.version + 1 } });
  });

  it("exposes version bumps through unconditional update and list reads", async () => {
    const harness = harnessWithFence();

    const created = await harness.ctx.issues.create({ companyId, title: "Bumping" });
    const updated = await harness.ctx.issues.update(created.id, { title: "Bumped" }, companyId);
    expect(updated.version).toBe(created.version + 1);

    const listed = await harness.ctx.issues.list({ companyId });
    expect(listed.map((issue) => issue.version)).toEqual([updated.version]);

    const applied = await harness.ctx.issues.updateConditional({
      issueId: created.id,
      companyId,
      patch: { title: "Bumped conditionally" },
      expectedVersion: updated.version,
      namespaceFence: fence,
    });
    expect(applied).toMatchObject({ applied: true, issue: { version: updated.version + 1 } });
  });

  it("keeps fence and tenancy rejections ahead of version checks", async () => {
    const harness = harnessWithFence();
    const created = await harness.ctx.issues.create({ companyId, title: "Fenced" });

    const mismatch = await harness.ctx.issues.updateConditional({
      issueId: created.id,
      companyId,
      patch: { title: "Must not apply" },
      expectedVersion: created.version,
      namespaceFence: { ...fence, expected: { fence_token: "stale", generation: 7 } },
    });
    expect(mismatch).toEqual({ applied: false, reason: "fence_mismatch" });

    const otherCompany = await harness.ctx.issues.updateConditional({
      issueId: created.id,
      companyId: "company-2",
      patch: { title: "Must not apply" },
      expectedVersion: created.version,
      namespaceFence: fence,
    });
    expect(otherCompany).toEqual({ applied: false, reason: "not_found" });

    const snapshot = await harness.ctx.issues.get(created.id, companyId);
    expect(snapshot?.title).toBe("Fenced");
    expect(snapshot?.version).toBe(created.version);
  });
});
