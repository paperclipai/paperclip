import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { findChatCatalogCase } from "./chat-catalog-registry.js";
import { stageChatPrivateInputs, chatPrivateInputNameIdentity, CHAT_PRIVATE_INPUTS_ENV } from "./chat-private-inputs.js";
import { chatCatalogCaseFingerprint, normalizedChatCatalogExecution } from "./chat-catalog-fingerprint.js";
it("reproduces the actual selected-case fingerprint after its raw private envelope is deleted", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chat-identity-replay-"));
  try {
    const descriptor = findChatCatalogCase("companies.configure-decision-model")!;
    const execution = runnerMatrix.find(e => e.suite.id === "chat-features" && e.task.id === descriptor.scenarioId)!;
    const staged = stageChatPrivateInputs({ execution, descriptor, privateDir: root, env: { OPENROUTER_API_KEY: "synthetic-offline-only" }, secrets: [] });
    vi.stubEnv(CHAT_PRIVATE_INPUTS_ENV, staged.filename); vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", root);
    const names = chatPrivateInputNameIdentity(execution.id)!;
    const selected = normalizedChatCatalogExecution(execution), before = chatCatalogCaseFingerprint(descriptor, selected).digest;
    expect(JSON.stringify(names)).not.toContain("synthetic-offline-only");
    rmSync(staged.filename);
    expect(chatCatalogCaseFingerprint(descriptor, selected, names).digest).toBe(before);
    expect(() => chatCatalogCaseFingerprint(descriptor, selected)).toThrow();
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
