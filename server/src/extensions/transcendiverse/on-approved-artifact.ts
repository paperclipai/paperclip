import fs from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import type { ArtifactCreatedEvent } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { registerArtifactCreatedHandler, removeArtifactCreatedHandler } from "../../services/index.js";
import { loadTranscendiverseVaultSyncConfig } from "./config.js";
import { mapArtifactToVault } from "./map-artifact-to-vault.js";
import { writeRawArtifactToVault } from "./write-raw-artifact.js";
import { writeVaultDistillation } from "./write-vault-distillation.js";

const HANDLER_ID = "transcendiverse-vault-sync";

function shouldHandleArtifact(event: ArtifactCreatedEvent) {
  if (event.status !== "approved") return false;
  return event.sourceType === "issue_document";
}

export function registerTranscendiverseApprovedArtifactHandler(_db: Db) {
  const config = loadTranscendiverseVaultSyncConfig();

  if (!config.enabled) {
    removeArtifactCreatedHandler(HANDLER_ID);
    logger.info("Transcendiverse approved document vault sync disabled");
    return;
  }

  if (!config.vaultRoot) {
    removeArtifactCreatedHandler(HANDLER_ID);
    logger.warn("Transcendiverse approved document vault sync enabled but vault root is missing");
    return;
  }

  registerArtifactCreatedHandler(HANDLER_ID, async (event) => {
    if (!shouldHandleArtifact(event)) return;

    const vaultPaths = mapArtifactToVault(config, event);
    const artifactContent = await fs.readFile(event.storagePath, "utf8");

    if (config.autoWriteRaw) {
      await writeRawArtifactToVault(vaultPaths.rawAbsolutePath, artifactContent);
    }

    if (config.autoWriteDistillation) {
      await writeVaultDistillation({
        event,
        rawArtifactContent: artifactContent,
        rawWikiLink: vaultPaths.rawWikiLink,
        targetPath: vaultPaths.distillationAbsolutePath,
      });
    }

    if (config.autoMergeCanonical) {
      logger.info(
        { artifactId: event.artifactId },
        "Transcendiverse canonical auto-merge requested but intentionally not implemented in v1",
      );
    }
  });

  logger.info({ vaultRoot: config.vaultRoot }, "Registered Transcendiverse approved document vault sync handler");
}
