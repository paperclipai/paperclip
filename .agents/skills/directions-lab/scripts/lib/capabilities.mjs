import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UsageError } from "./args.mjs";

export const CAPABILITY_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/;

export async function loadFeatureIndex(root) {
  const script = path.join(root, "scripts/feature-map.mjs");
  if (!existsSync(script)) throw new UsageError(`cannot validate capabilities: ${script} is missing (run from the repo root, or pass no --capabilities)`);
  const { featureIndex } = await import(pathToFileURL(script).href);
  return featureIndex(root);
}

export function allCapabilities(index) {
  return index.sections.flatMap((section) => section.features.flatMap((feature) => feature.capabilities));
}

export function parseCapabilities(text) {
  if (!text) return [];
  const ids = text.split(",").map((id) => id.trim()).filter(Boolean);
  const malformed = ids.filter((id) => !CAPABILITY_PATTERN.test(id));
  if (malformed.length) throw new UsageError(`capabilities must be <area>/<key>: ${malformed.join(", ")}`);
  if (new Set(ids).size !== ids.length) throw new UsageError("duplicate capability ids");
  return ids;
}

export function candidates(index, term) {
  const needle = term.toLowerCase();
  return allCapabilities(index)
    .filter((capability) => capability.id.includes(needle) || capability.description.toLowerCase().includes(needle))
    .map((capability) => capability.id);
}

export async function validateCapabilities(root, text) {
  const ids = parseCapabilities(text);
  if (!ids.length) return ids;
  const index = await loadFeatureIndex(root);
  const known = new Set(allCapabilities(index).map((capability) => capability.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    const hints = unknown.map((id) => {
      const near = candidates(index, id.split("/")[1] ?? id).slice(0, 5);
      return `  ${id}${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`;
    });
    throw new UsageError(`unknown capabilities (maps/feature-map/<area>.md ## Sub-features):\n${hints.join("\n")}`);
  }
  return ids;
}
