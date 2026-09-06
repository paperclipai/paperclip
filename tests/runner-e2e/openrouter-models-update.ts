import { writeFile } from "node:fs/promises";
import {
  rankingContentHash,
  validateOpenRouterRankingSnapshot,
  type OpenRouterRankedModel,
} from "./openrouter-ranking.js";

const sourceUrl =
  "https://openrouter.ai/api/v1/models?sort=top-weekly&supported_parameters=tools";

interface OpenRouterModelResponse {
  data?: Array<{
    id?: string;
    name?: string;
    supported_parameters?: string[];
  }>;
}

const response = await fetch(sourceUrl, {
  headers: { Accept: "application/json" },
});
if (!response.ok) {
  throw new Error(`OpenRouter ranking request failed with ${response.status}`);
}
const payload = (await response.json()) as OpenRouterModelResponse;
const models: OpenRouterRankedModel[] = (payload.data ?? [])
  .filter(
    (
      model,
    ): model is Required<
      NonNullable<OpenRouterModelResponse["data"]>[number]
    > =>
      Boolean(
        model.id && model.name && model.supported_parameters?.includes("tools"),
      ),
  )
  .slice(0, 5)
  .map((model, index) => ({
    rank: index + 1,
    id: model.id,
    name: model.name,
    supportedParameters: [...new Set(model.supported_parameters)].sort(),
  }));
const capturedAt = new Date().toISOString();
const snapshot = validateOpenRouterRankingSnapshot({
  schema: "paperclip.runner-e2e.openrouter-ranking/v1",
  snapshotId: `top-weekly-tools-${capturedAt.slice(0, 10)}`,
  ranking: "top-weekly",
  requiredParameter: "tools",
  sourceUrl,
  capturedAt,
  contentHash: rankingContentHash(models),
  models,
});
const output = new URL("./openrouter-models.json", import.meta.url);
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(
  `Pinned ${snapshot.models.length} OpenRouter model(s) in ${output.pathname}`,
);
