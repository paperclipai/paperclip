import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const MODE_A_SENTENCE = "design proposal home requires proposed status";

export function detectMode(root) {
  const script = path.join(root, "scripts/storybook-catalog.mjs");
  if (!existsSync(script)) return "A";
  return readFileSync(script, "utf8").includes(MODE_A_SENTENCE) ? "A" : "B";
}

export function labStage(directions) {
  const explorations = directions.filter((direction) => !direction.baseline);
  if (!explorations.length) return "proposed";
  if (explorations.some((direction) => direction.stage === "proposed" || direction.stage === "adopted")) return "proposed";
  if (explorations.every((direction) => direction.stage === "historical")) return "historical";
  return "current";
}

export function expectedStoryStatus(mode, stage) {
  if (mode === "A") return "proposed";
  if (stage === "current") return "current";
  if (stage === "historical") return "historical";
  return "proposed";
}
