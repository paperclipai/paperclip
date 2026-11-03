import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveDefaultSecretsKeyFilePath } from "../home-paths.js";
import { resolveDecisionSigningSecret, signDecisionSpec, verifyDecisionSpec } from "./decision-signing.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "decision-migration-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
it("does not manufacture a replacement key when the legacy volume is missing", () => {
  const key = path.join(path.dirname(resolveDefaultSecretsKeyFilePath()), "decision-signing.key");
  expect(() => resolveDecisionSigningSecret({ allowCreate: false })).toThrow();
  expect(existsSync(key)).toBe(false);
});
it("preserves decision signatures after the original key moves to environment storage", async () => {
  const original = resolveDecisionSigningSecret();
  const spec = { action: "approve", id: "retained-decision" };
  const signature = signDecisionSpec(spec);
  expect(resolveDecisionSigningSecret({ allowCreate: false })).toBe(original);
  await rm(home, { recursive: true, force: true });
  vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", original);
  expect(resolveDecisionSigningSecret({ allowCreate: false })).toBe(original);
  expect(verifyDecisionSpec(spec, signature)).toBe(true);
});
