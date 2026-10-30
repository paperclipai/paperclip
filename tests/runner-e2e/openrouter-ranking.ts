import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface OpenRouterRankedModel {
  rank: number;
  id: string;
  name: string;
  supportedParameters: string[];
}

export interface OpenRouterRankingSnapshot {
  schema: "paperclip.runner-e2e.openrouter-ranking/v1";
  snapshotId: string;
  ranking: "top-weekly";
  requiredParameter: "tools";
  sourceUrl: string;
  capturedAt: string;
  contentHash: string;
  models: OpenRouterRankedModel[];
}

export function rankingContentHash(models: readonly OpenRouterRankedModel[]) {
  return createHash("sha256").update(JSON.stringify(models)).digest("hex");
}

export function validateOpenRouterRankingSnapshot(
  value: unknown,
): OpenRouterRankingSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter ranking snapshot must be an object");
  }
  const snapshot = value as Partial<OpenRouterRankingSnapshot>;
  if (snapshot.schema !== "paperclip.runner-e2e.openrouter-ranking/v1") {
    throw new Error("OpenRouter ranking snapshot has an unknown schema");
  }
  if (
    snapshot.ranking !== "top-weekly" ||
    snapshot.requiredParameter !== "tools" ||
    !snapshot.snapshotId?.trim() ||
    !snapshot.sourceUrl?.startsWith("https://openrouter.ai/") ||
    !snapshot.capturedAt ||
    Number.isNaN(Date.parse(snapshot.capturedAt)) ||
    !Array.isArray(snapshot.models) ||
    snapshot.models.length !== 5
  ) {
    throw new Error("OpenRouter ranking snapshot metadata is invalid");
  }
  const ids = new Set<string>();
  for (const [index, model] of snapshot.models.entries()) {
    if (
      model.rank !== index + 1 ||
      !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(model.id) ||
      !model.name?.trim() ||
      !model.supportedParameters?.includes("tools") ||
      ids.has(model.id)
    ) {
      throw new Error(`OpenRouter ranked model ${index + 1} is invalid`);
    }
    ids.add(model.id);
  }
  if (snapshot.contentHash !== rankingContentHash(snapshot.models)) {
    throw new Error("OpenRouter ranking snapshot content hash is invalid");
  }
  return snapshot as OpenRouterRankingSnapshot;
}

export const openRouterRankingSnapshot = validateOpenRouterRankingSnapshot(
  JSON.parse(
    readFileSync(new URL("./openrouter-models.json", import.meta.url), "utf8"),
  ),
);

export function openRouterProfileId(modelId: string) {
  return `openrouter-${modelId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
