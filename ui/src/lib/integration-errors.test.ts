// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { describeUiError, uiErrorDescriptor } from "./localized-ui-error";
import { buildExecutionPolicy } from "./localized-issue-execution-policy";
import { stopFailedNativeRun } from "./native-run-stop";
import { qualifyRunnerEnvironment } from "./qualify-claude-setup";
import { readZipArchive } from "./zip";
import { readStagedIssueFiles } from "./staged-issue-files";
import { createVoiceCallAttempt } from "./voice-call-attempt";
import { connectSpekoVoiceMedia } from "./speko-voice-media";
import { waitForStoppedRuns } from "./wait-for-stopped-runs";
import { loadArtifactCsv, parseArtifactCsv } from "./artifact-card-data";
import { auditApi } from "@/api/audit";
import { heartbeatsApi } from "@/api/heartbeats";
import { accessApi } from "@/api/access";
import { api } from "@/api/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import type { AdapterInfo } from "@/api/adapters";
import type { voiceSessionsApi } from "@/api/voiceSessions";
const sdk = vi.hoisted(() => ({ canPlaybackAudio: false, startAudioPlayback: vi.fn(async () => {}) }));
vi.mock("@spekoai/client", () => ({ VoiceConversation: { create: async () => sdk } }));
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await i18n.changeLanguage("en"); });
async function failure(action: () => unknown): Promise<Error> {
  try { await action(); } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
  throw new Error("Expected the operation to fail");
}
async function localized(error: Error, key: string) {
  const raw = Object.getOwnPropertyDescriptors(error);
  expect(uiErrorDescriptor(error)?.key).toBe(`integration-errors:${key}`);
  for (const locale of ["en", "zh-CN", "en"]) {
    await i18n.changeLanguage(locale);
    expect(describeUiError(error).body).toBe(i18n.t(`integration-errors:${key}`, uiErrorDescriptor(error)?.values));
    expect(describeUiError(new Error(error.message)).body).toBe(error.message);
    expect(Object.getOwnPropertyDescriptors(error)).toEqual(raw);
  }
}
it("retains all artifact parser/load guards and raw provider failures", async () => {
  await localized(await failure(() => parseArtifactCsv("x".repeat(1024 * 1024 + 1))), "csvTooLarge");
  await localized(await failure(() => parseArtifactCsv(Array(51).fill("x").join(","))), "csvColumns");
  await localized(await failure(() => parseArtifactCsv('"x"z')), "csvMalformed");
  await localized(await failure(() => parseArtifactCsv('"x')), "csvMalformed");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await localized(await failure(() => loadArtifactCsv("https://provider.invalid/data.csv")), "csvUnavailable"); expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue({ ok: false }); await localized(await failure(() => loadArtifactCsv("/api/attachments/id/content")), "csvLoad");
  const cancel = vi.fn(); fetcher.mockResolvedValue({ ok: true, headers: new Headers({ "content-length": "1048577" }), body: { cancel } });
  await localized(await failure(() => loadArtifactCsv("/api/attachments/id/content")), "csvTooLarge"); expect(cancel).toHaveBeenCalledOnce();
  fetcher.mockResolvedValue({ ok: true, headers: new Headers(), body: null });
  await localized(await failure(() => loadArtifactCsv("/api/attachments/id/content")), "csvLoad");
  const reader = { read: vi.fn(async () => ({ value: new Uint8Array(1048577), done: false })), cancel: vi.fn(), releaseLock: vi.fn() };
  fetcher.mockResolvedValue({ ok: true, headers: new Headers(), body: { getReader: () => reader } });
  await localized(await failure(() => loadArtifactCsv("/api/attachments/id/content")), "csvTooLarge"); expect(reader.cancel).toHaveBeenCalledOnce(); expect(reader.releaseLock).toHaveBeenCalledOnce();
  const raw = new Error("CSV could not be loaded. Try again or download the file.", { cause: "vendor cause" });
  fetcher.mockRejectedValue(raw); expect(await failure(() => loadArtifactCsv("/api/attachments/id/content"))).toBe(raw); expect(uiErrorDescriptor(raw)).toBeUndefined();
});
it("tags invalid execution policy without changing policy data or valid defaults", async () => {
  const policy = { stages: "vendor invalid" }; const original = JSON.stringify(policy);
  await localized(await failure(() => buildExecutionPolicy({ existingPolicy: policy as never, reviewerValues: [], approverValues: [] })), "policyUnavailable");
  expect(JSON.stringify(policy)).toBe(original); expect(buildExecutionPolicy({ reviewerValues: [], approverValues: [] })).toBeNull();
});
it("retains all four native-stop identity/permission guards and heartbeat acknowledgement", async () => {
  const run = { id: "run", companyId: "company", resultJson: null } as unknown as HeartbeatRun;
  const get = vi.spyOn(heartbeatsApi, "get").mockResolvedValue({ ...run, id: "other" });
  const access = vi.spyOn(accessApi, "getCurrentBoardAccess").mockResolvedValue({ userId: "actor" } as never);
  const cancel = vi.spyOn(heartbeatsApi, "cancel");
  await localized(await failure(() => stopFailedNativeRun("run", "company")), "stopRunChanged");
  get.mockResolvedValue(run); access.mockResolvedValue({ userId: null } as never);
  await localized(await failure(() => stopFailedNativeRun("run", "company")), "stopSessionChanged");
  access.mockResolvedValue({ userId: "actor" } as never);
  get.mockResolvedValue({ ...run, resultJson: { startupCancellation: { cancellationRequestId: "bad", requestedBy: { type: "board", userId: "other" } } } });
  await localized(await failure(() => stopFailedNativeRun("run", "company")), "stopOtherOperator");
  get.mockResolvedValue({ ...run, resultJson: { startupCancellation: { cancellationRequestId: "bad", requestedBy: { type: "board", userId: "actor" } } } });
  await localized(await failure(() => stopFailedNativeRun("run", "company")), "stopRunChanged"); expect(cancel).not.toHaveBeenCalled();
  cancel.mockRestore(); vi.spyOn(api, "post").mockResolvedValue({ ...run, status: "running" });
  await localized(await failure(() => heartbeatsApi.cancel("run", { cancellationRequestId: "request" })), "stopRunChanged");
});
it("qualifies only own failures; provider summaries and identical English remain untagged", async () => {
  const input = { adapterType: "claude_local", readAdapters: async () => [] as AdapterInfo[], probeEnvironment: vi.fn(), isCurrent: () => true };
  await localized(await failure(() => qualifyRunnerEnvironment(input)), "runnerUnavailable"); expect(input.probeEnvironment).not.toHaveBeenCalled();
  input.readAdapters = async () => [{ type: "claude_local", defaultRunner: "legacy", supportedRunners: ["legacy"] }, { type: "paperclip_runner" }] as AdapterInfo[];
  input.probeEnvironment.mockResolvedValue({ ok: false });
  const own = await failure(() => qualifyRunnerEnvironment(input)); await localized(own, "qualificationUnconfirmed");
  for (const probe of [{ ok: false, summary: own.message }, { ok: false, details: { platformQualificationDiagnostic: own.message } }]) {
    input.probeEnvironment.mockResolvedValue(probe); const raw = await failure(() => qualifyRunnerEnvironment(input)); expect(raw.message).toBe(own.message); expect(uiErrorDescriptor(raw)).toBeUndefined();
  }
});
function archive(options: { length?: number; signature?: number; flags?: number; compression?: number; size?: number } = {}) {
  const b = new Uint8Array(options.length ?? 31); const v = new DataView(b.buffer);
  v.setUint32(0, options.signature ?? 0x04034b50, true);
  if (b.length >= 30) { v.setUint16(6, options.flags ?? 0, true); v.setUint16(8, options.compression ?? 0, true); v.setUint32(18, options.size ?? 0, true); v.setUint16(26, 1, true); b[30] = 120; }
  return b;
}
it("localizes each of six archive-owned failures while keeping source bytes identical", async () => {
  const cases: [Uint8Array, string][] = [[archive({ signature: 1 }), "zipHeader"], [archive({ length: 4 }), "zipTruncatedHeader"], [archive({ flags: 8 }), "zipDescriptors"], [archive({ size: 100 }), "zipTruncatedContents"], [archive({ compression: 9 }), "zipCompression"], [archive({ compression: 8 }), "zipBrowser"]];
  vi.stubGlobal("DecompressionStream", undefined);
  for (const [source, key] of cases) { const before = [...source]; await localized(await failure(() => readZipArchive(source)), key); expect([...source]).toEqual(before); }
});
it("tags blocked draft storage without replacing the original rejection", async () => {
  const request = {} as IDBOpenDBRequest;
  vi.stubGlobal("indexedDB", { open: vi.fn(() => { queueMicrotask(() => request.onblocked?.({} as IDBVersionChangeEvent)); return request; }) });
  await localized(await failure(() => readStagedIssueFiles("raw-key")), "draftStorageBlocked");
});
it("tags own media playback and unconfirmed hangup, preserving call recovery data", async () => {
  const media = await connectSpekoVoiceMedia({ sessionId: "s", generation: 1, transportToken: "raw", transportUrl: "raw" }, {} as never);
  await localized(await failure(() => media.startAudioPlayback()), "audioBlocked");
  const clear = vi.fn(); const journal = { read: () => undefined, write: vi.fn(), clear };
  const attempt = createVoiceCallAttempt("company", { end: async () => ({ state: "active" }) } as unknown as typeof voiceSessionsApi, journal);
  await localized(await failure(() => attempt.end("s")), "hangupUnconfirmed"); expect(clear).not.toHaveBeenCalled();
});
it("tags audit fallback only, preserving server error collisions", async () => {
  const fetcher = vi.fn(async () => ({ ok: false, status: 403, json: async () => null })); vi.stubGlobal("fetch", fetcher);
  const own = await failure(() => auditApi.exportAgentActionsCsv("company")); await localized(own, "auditExport");
  fetcher.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: own.message }) } as never);
  const raw = await failure(() => auditApi.exportAgentActionsCsv("company")); expect(uiErrorDescriptor(raw)).toBeUndefined(); expect(raw.message).toBe(own.message);
});
it("retains StopVerificationError run IDs and raw English independent of locale at origin", async () => {
  await i18n.changeLanguage("zh-CN");
  const own = await failure(() => waitForStoppedRuns(["r", "r"], { timeoutMs: 0 }));
  expect(own.message).toBe("The stop was requested, but work is still stopping. Try Stop again if it continues.");
  expect(own).toMatchObject({ name: "StopVerificationError", runIds: ["r"] }); await localized(own, "stopStillStopping");
  const err = await failure(() => waitForStoppedRuns(["r"], { getRun: async () => { throw new Error("provider"); } })); await localized(err, "stopVerification");
});
