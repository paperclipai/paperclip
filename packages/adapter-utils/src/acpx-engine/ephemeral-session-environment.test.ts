import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeStore, type AcpSessionRecord, type AcpSessionStore } from "acpx/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEphemeralSessionEnvironmentStore } from "./ephemeral-session-environment.js";

const currentEnvironment = Object.freeze({
  PAPERCLIP_API_KEY: "current-credential-fixture",
  PAPERCLIP_RUN_ID: "current-run-fixture",
  PATH: "/fixture/current-bin",
});
const oldEnvironment = { PAPERCLIP_API_KEY: "old-credential-fixture", OLD_RUN_PATH: "/fixture/old-run" };

function record(): AcpSessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "fixture-record",
    acpSessionId: "fixture-session",
    agentSessionId: "fixture-agent-session",
    agentCommand: "fixture-provider",
    cwd: "/fixture/project",
    name: "fixture-name",
    createdAt: "2026-10-03T00:00:00.000Z",
    lastUsedAt: "2026-10-03T00:00:01.000Z",
    lastSeq: 3,
    eventLog: { active_path: "/fixture/events.jsonl", segment_count: 1, max_segment_bytes: 1024, max_segments: 2 },
    messages: [{ User: { id: "message-1", content: [{ Text: "Retained conversation" }] } }],
    updated_at: "2026-10-03T00:00:01.000Z",
    cumulative_token_usage: { input_tokens: 11, output_tokens: 7 },
    request_token_usage: { request_1: { input_tokens: 11 } },
    importedFrom: { recordId: "origin-record", cwdOriginal: "/fixture/origin", exportedBy: "fixture-caller", exportedAt: "2026-10-03T00:00:00.000Z" },
    acpx: {
      current_mode_id: "code",
      desired_config_options: { effort: "high" },
      session_options: { model: "fixture-model", allowed_tools: ["Read", "Write"], max_turns: 4, system_prompt: { append: "Retained caller option" }, env: { ...currentEnvironment } },
    },
  };
}
function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (typeof child === "object" && child !== null) freeze(child);
  return Object.freeze(value);
}
function stubStore(loaded: AcpSessionRecord | undefined) {
  const load = vi.fn<AcpSessionStore["load"]>().mockResolvedValue(loaded);
  const save = vi.fn<AcpSessionStore["save"]>().mockResolvedValue(undefined);
  return { load, save };
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function diskStore() {
  const stateDir = await mkdtemp(join(tmpdir(), "paperclip-session-env-")); directories.push(stateDir);
  return { store: createRuntimeStore({ stateDir }), file: join(stateDir, "sessions", "fixture-record.json") };
}

describe("ephemeral ACPX session environment", () => {
  it("saves a fresh session to the actual file store without persisting its live environment", async () => {
    const disk = await diskStore(), input = freeze(record());
    const wrapper = createEphemeralSessionEnvironmentStore(disk.store, currentEnvironment);
    await wrapper.save(input);
    const text = await readFile(disk.file, "utf8"), saved = JSON.parse(text);
    expect(saved.acpx.session_options).not.toHaveProperty("env");
    for (const value of Object.values(currentEnvironment)) expect(text).not.toContain(value);
    expect(input.acpx?.session_options?.env).toEqual(currentEnvironment);
    expect(saved.acpx.current_mode_id).toBe("code");
    expect(saved.acpx.desired_config_options).toEqual(input.acpx?.desired_config_options);
    expect(saved.acpx.session_options).toEqual({ model: "fixture-model", allowed_tools: ["Read", "Write"], max_turns: 4, system_prompt: { append: "Retained caller option" } });
    expect(saved.messages).toEqual(input.messages);
    expect(saved.imported_from.record_id).toBe("origin-record");
    const loaded = await wrapper.load(input.acpxRecordId);
    expect(loaded?.acpx?.session_options?.env).toEqual(currentEnvironment);
    expect(loaded?.messages).toEqual(input.messages);
  });

  it("loads an old env-bearing file with rotated credentials without writing, then saves neither environment", async () => {
    const disk = await diskStore(), legacy = record(); legacy.acpx!.session_options!.env = { ...oldEnvironment };
    await disk.store.save(legacy);
    const before = await readFile(disk.file, "utf8");
    const wrapper = createEphemeralSessionEnvironmentStore(disk.store, currentEnvironment);
    const loaded = await wrapper.load(legacy.acpxRecordId);
    expect(loaded?.acpx?.session_options?.env).toEqual(currentEnvironment);
    expect(loaded?.acpx?.session_options?.env).not.toHaveProperty("OLD_RUN_PATH");
    expect(await readFile(disk.file, "utf8")).toBe(before);
    expect(legacy.acpx?.session_options?.env).toEqual(oldEnvironment);
    await wrapper.save(loaded!);
    const after = await readFile(disk.file, "utf8");
    for (const value of [...Object.values(oldEnvironment), ...Object.values(currentEnvironment)]) expect(after).not.toContain(value);
    expect(JSON.parse(after).acpx.session_options).not.toHaveProperty("env");
    expect(loaded?.acpx?.session_options?.env).toEqual(currentEnvironment);
  });

  it("loads an env-free persisted session into the current environment without writing", async () => {
    const disk = await diskStore(), input = record(); delete input.acpx!.session_options!.env;
    await disk.store.save(input);
    const before = await readFile(disk.file, "utf8");
    const loaded = await createEphemeralSessionEnvironmentStore(disk.store, currentEnvironment).load(input.acpxRecordId);
    expect(loaded?.acpx?.session_options?.env).toEqual(currentEnvironment);
    expect(loaded?.acpx?.session_options?.model).toBe("fixture-model");
    expect(await readFile(disk.file, "utf8")).toBe(before);
  });

  it("copies loaded records, options and current env without mutating stored or caller-owned objects", async () => {
    const stored = record(); stored.acpx!.session_options!.env = { ...oldEnvironment }; freeze(stored);
    const backing = stubStore(stored), wrapper = createEphemeralSessionEnvironmentStore(backing, currentEnvironment);
    const loaded = await wrapper.load("fixture-record");
    expect(backing.load).toHaveBeenCalledWith("fixture-record"); expect(backing.save).not.toHaveBeenCalled();
    expect(loaded).not.toBe(stored); expect(loaded?.acpx).not.toBe(stored.acpx);
    expect(loaded?.acpx?.session_options).not.toBe(stored.acpx?.session_options);
    expect(loaded?.acpx?.session_options?.env).not.toBe(currentEnvironment);
    expect(stored.acpx?.session_options?.env).toEqual(oldEnvironment);
    loaded!.acpx!.session_options!.env!.PAPERCLIP_API_KEY = "isolated-loaded-fixture";
    expect(currentEnvironment.PAPERCLIP_API_KEY).toBe("current-credential-fixture");
  });

  it("saves only a copied env-free projection, preserving unrelated and caller metadata", async () => {
    const input = freeze(Object.assign(record(), { caller_metadata: { keep: "caller-state", env: { preserve: "unrelated caller metadata" } } }));
    const backing = stubStore(undefined), wrapper = createEphemeralSessionEnvironmentStore(backing, currentEnvironment);
    await wrapper.save(input);
    const saved = backing.save.mock.calls[0]![0];
    const { env: _environment, ...expectedOptions } = input.acpx!.session_options!;
    expect(saved).toEqual({ ...input, acpx: { ...input.acpx, session_options: expectedOptions } });
    expect(saved).not.toBe(input); expect(saved.acpx).not.toBe(input.acpx);
    expect(saved.acpx?.session_options).not.toBe(input.acpx?.session_options);
    expect(saved.acpx?.session_options).not.toHaveProperty("env");
    expect(input.acpx?.session_options?.env).toEqual(currentEnvironment);
  });

  for (const [name, acpx] of [
    ["absent acpx", undefined],
    ["explicit undefined acpx", undefined],
    ["absent session options", { current_mode_id: "code" }],
    ["undefined session options", { session_options: undefined }],
    ["empty session options", { session_options: {} }],
    ["undefined env", { session_options: { env: undefined, model: "fixture-model" } }],
  ] as const) it(`preserves ${name} when saving and retains existing load injection semantics`, async () => {
    const input = record();
    if (name === "absent acpx") delete input.acpx; else input.acpx = acpx;
    freeze(input);
    const backing = stubStore(input), wrapper = createEphemeralSessionEnvironmentStore(backing, currentEnvironment);
    await wrapper.save(input);
    const saved = backing.save.mock.calls[0]![0];
    if (name === "undefined env") expect(saved.acpx?.session_options).toEqual({ model: "fixture-model" });
    else expect(saved).toEqual(input);
    expect(Object.hasOwn(saved, "acpx")).toBe(Object.hasOwn(input, "acpx"));
    if (saved.acpx && input.acpx) expect(Object.hasOwn(saved.acpx, "session_options")).toBe(Object.hasOwn(input.acpx, "session_options"));
    const loaded = await wrapper.load(input.acpxRecordId);
    expect(loaded?.acpx?.session_options?.env).toEqual(currentEnvironment);
    expect(backing.save).toHaveBeenCalledTimes(1);
  });

  it("returns a missing record without saving or creating conversation state", async () => {
    const backing = stubStore(undefined);
    expect(await createEphemeralSessionEnvironmentStore(backing, currentEnvironment).load("missing")).toBeUndefined();
    expect(backing.save).not.toHaveBeenCalled();
  });

  it("propagates load and save errors unchanged", async () => {
    const failure = new Error("fixture store failure"), backing = stubStore(undefined);
    backing.load.mockRejectedValue(failure); backing.save.mockRejectedValue(failure);
    const wrapper = createEphemeralSessionEnvironmentStore(backing, currentEnvironment);
    await expect(wrapper.load("fixture-record")).rejects.toBe(failure);
    const input = freeze(record()); await expect(wrapper.save(input)).rejects.toBe(failure);
    expect(input.acpx?.session_options?.env).toEqual(currentEnvironment);
  });
});
