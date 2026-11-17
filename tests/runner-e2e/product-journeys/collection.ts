import { JourneyError, type JourneyCollection } from "./types.js";

/** Reject accidental raw run records or credentials at the private-provider boundary. */
export function validateJourneyCollection(receipt: JourneyCollection) {
  const closed = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new JourneyError("failed", "invalid_collection_receipt");
  };
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
  closed(receipt, ["journeyId", "runIds", "usage", "operations"]);
  if (!Array.isArray(receipt.runIds) || receipt.runIds.some(value => !id(value)) || new Set(receipt.runIds).size !== receipt.runIds.length) throw new JourneyError("failed", "invalid_collection_runs");
  closed(receipt.usage, ["runs"]);
  if (!Array.isArray(receipt.usage.runs) || receipt.usage.runs.length !== receipt.runIds.length) throw new JourneyError("failed", "invalid_collection_usage");
  for (const [index, run] of receipt.usage.runs.entries()) {
    closed(run, ["runId", "usage"]);
    if (run.runId !== receipt.runIds[index]) throw new JourneyError("failed", "invalid_collection_usage");
    closed(run.usage, ["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"]);
    if (Object.values(run.usage).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new JourneyError("failed", "invalid_collection_usage");
  }
  return receipt;
}
