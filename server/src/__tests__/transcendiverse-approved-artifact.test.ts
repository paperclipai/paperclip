import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactCreatedEvent } from "@paperclipai/shared";
import { clearArtifactCreatedHandlers, emitArtifactCreated } from "../services/artifact-events.ts";
import { loadTranscendiverseVaultSyncConfig } from "../extensions/transcendiverse/config.ts";
import { mapArtifactToVault } from "../extensions/transcendiverse/map-artifact-to-vault.ts";
import { registerTranscendiverseApprovedArtifactHandler } from "../extensions/transcendiverse/on-approved-artifact.ts";

const ORIGINAL_ENV = { ...process.env };

describe("Transcendiverse approved document vault sync", () => {
  let tempRoot = "";
  let vaultRoot = "";
  let sourceArtifactPath = "";

  beforeEach(() => {
    clearArtifactCreatedHandlers();
    process.env = { ...ORIGINAL_ENV };

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-transcendiverse-"));
    vaultRoot = path.join(tempRoot, "vault");
    sourceArtifactPath = path.join(tempRoot, "approved-artifact.md");

    fs.mkdirSync(vaultRoot, { recursive: true });
    fs.writeFileSync(
      sourceArtifactPath,
      [
        "---",
        'artifactId: "artifact-1"',
        "---",
        "",
        "# Approved Snapshot: Review Plan",
        "",
        "## Approved Content",
        "The board approved a stable doctrine note.",
        "",
        "## Context Metadata",
        "```json",
        '{"issueId":"issue-1"}',
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    process.env.PAPERCLIP_TRANSCENDIVERSE_VAULT_SYNC_ENABLED = "true";
    process.env.PAPERCLIP_TRANSCENDIVERSE_VAULT_ROOT = vaultRoot;
    process.env.PAPERCLIP_TRANSCENDIVERSE_RAW_IMPORT_DIR = "wiki/sources/internal/paperclip";
    process.env.PAPERCLIP_TRANSCENDIVERSE_DISTILLATION_DIR = "wiki/syntheses/paperclip";
    process.env.PAPERCLIP_TRANSCENDIVERSE_AUTO_WRITE_RAW = "true";
    process.env.PAPERCLIP_TRANSCENDIVERSE_AUTO_WRITE_DISTILLATION = "true";
    process.env.PAPERCLIP_TRANSCENDIVERSE_AUTO_MERGE_CANONICAL = "false";
  });

  afterEach(() => {
    clearArtifactCreatedHandlers();
    process.env = { ...ORIGINAL_ENV };
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  function createEvent(overrides?: Partial<ArtifactCreatedEvent>): ArtifactCreatedEvent {
    return {
      artifactId: "artifact-1",
      companyId: "company-1",
      sourceType: "issue_document",
      sourceId: "document-1",
      status: "approved",
      version: 1,
      format: "markdown",
      storageType: "file",
      storagePath: sourceArtifactPath,
      contentHash: "hash-1",
      metadata: {
        issueId: "issue-1",
        issueIdentifier: "TRA-6",
        issueTitle: "Research note approval",
        approvedAt: "2026-04-10T00:00:00.000Z",
        documentKey: "review",
      },
      ...overrides,
    };
  }

  it("writes both the raw approved document snapshot and the distilled companion note into the vault", async () => {
    registerTranscendiverseApprovedArtifactHandler({} as never);

    const event = createEvent();
    const paths = mapArtifactToVault(loadTranscendiverseVaultSyncConfig(), event);

    await emitArtifactCreated(event);

    expect(fs.existsSync(paths.rawAbsolutePath)).toBe(true);
    expect(fs.existsSync(paths.distillationAbsolutePath)).toBe(true);

    const rawContent = fs.readFileSync(paths.rawAbsolutePath, "utf8");
    expect(rawContent).toContain("# Approved Snapshot: Review Plan");

    const distilled = fs.readFileSync(paths.distillationAbsolutePath, "utf8");
    expect(distilled).toContain("# Distillation: Research note approval");
    expect(distilled).toContain("[[wiki/sources/internal/paperclip/2026/tra-6-review-approved-v001]]");
  });

  it("ignores non-document artifact source types", async () => {
    registerTranscendiverseApprovedArtifactHandler({} as never);

    const event = createEvent({
      sourceType: "issue_legacy_plan",
      sourceId: "issue-1",
    });

    await emitArtifactCreated(event);

    const entries = fs.readdirSync(vaultRoot, { recursive: true });
    expect(entries).toHaveLength(0);
  });
});
