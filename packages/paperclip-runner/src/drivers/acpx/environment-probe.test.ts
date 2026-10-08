import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessSession } from "../../contracts/harness-driver.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { CodexAcpxDriver, probeQualifiedAcpxEnvironment } from "./codex-acpx-driver.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";

afterEach(() => vi.restoreAllMocks());

const options = { runtimeDirectory: "/private/probe", agent: "claude" as const, model: "claude-sonnet-5", environment: { CLAUDE_CODE_OAUTH_TOKEN: "selected-account-token" } };
function fixture(events: Array<Pick<PrpEvent, "eventType" | "payload">>) {
  const session = {
    snapshot: vi.fn(async () => ({ providerIdentity: { kind: "acpx", effectiveModel: options.model } })),
    startTurn: vi.fn(async () => ({ turnId: "hello-turn" })),
    events: vi.fn(async function* () {
      for (const event of events) yield { ...event, turnId: "hello-turn" } as PrpEvent;
    }),
    close: vi.fn(async () => undefined),
  };
  const open = vi.spyOn(CodexAcpxDriver.prototype, "openSession").mockResolvedValue(session as unknown as HarnessSession);
  return { session, open };
}

describe("qualified native environment probe", () => {
  it("keeps installation qualification free of provider turns by default", async () => {
    const f = fixture([]);
    const receipt = await probeQualifiedAcpxEnvironment(options);
    expect(receipt).toEqual({ effectiveModel: options.model, commandDigest: resolveQualifiedAcpxProfile(options.agent, options.model).commandDigest });
    expect(f.session.startTurn).not.toHaveBeenCalled();
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: options.runtimeDirectory, signal: expect.any(AbortSignal) }));
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it("requires a real response and successful terminal turn before reporting authentication", async () => {
    const f = fixture([
      { eventType: "item.completed", payload: { kind: "agentMessage", text: "hello" } },
      { eventType: "turn.completed", payload: { status: "completed" } },
    ]);
    await expect(probeQualifiedAcpxEnvironment({ ...options, hello: true })).resolves.toEqual(expect.objectContaining({ helloProbePassed: true, effectiveModel: options.model }));
    expect(f.session.startTurn).toHaveBeenCalledExactlyOnceWith({ message: { role: "user", text: "Respond only with hello. Do not use tools or inspect files." } });
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it.each([
    [[{ eventType: "turn.failed", payload: { error: { message: "Authentication failed" } } }], "Authentication failed"],
    [[{ eventType: "turn.completed", payload: { status: "completed" } }], "no response"],
    [[], "without a successful turn"],
  ] as const)("does not turn unsuccessful native execution into a readiness pass", async (events, message) => {
    const f = fixture([...events]);
    await expect(probeQualifiedAcpxEnvironment({ ...options, hello: true })).rejects.toThrow(message);
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it("bounds a stalled provider turn and closes its native session", async () => {
    const f = fixture([]);
    f.session.startTurn.mockImplementation(() => new Promise(() => {}));
    await expect(probeQualifiedAcpxEnvironment({ ...options, hello: true, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it("does not return a pass until provider and credential cleanup is confirmed", async () => {
    const f = fixture([
      { eventType: "item.completed", payload: { kind: "agentMessage", text: "hello" } },
      { eventType: "turn.completed", payload: { status: "completed" } },
    ]);
    f.session.close.mockRejectedValue(new Error("Provider cleanup is still owned by recovery"));
    await expect(probeQualifiedAcpxEnvironment({ ...options, hello: true })).rejects.toThrow("cleanup");
  });

  it.each([false, true])("preserves a selected Grok refresh only after provider exit (failed turn: %s)", async failed => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "grok-setup-probe-test-"));
    try {
      const f = fixture(failed ? [{ eventType: "turn.failed", payload: { error: { message: "Provider rejected turn" } } }]
        : [{ eventType: "item.completed", payload: { kind: "agentMessage", text: "hello" } }, { eventType: "turn.completed", payload: { status: "completed" } }]);
      const refresh = vi.fn(async filename => {
        expect(f.session.close).toHaveBeenCalledOnce();
        expect(filename).toContain("/grok-home/auth-refresh.json");
      });
      const result = probeQualifiedAcpxEnvironment({ ...options, runtimeDirectory, agent: "grok", environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: "selected-grok-login" }, hello: true, onGrokCredentialRefresh: refresh });
      if (failed) await expect(result).rejects.toThrow("Provider rejected turn");
      else await expect(result).resolves.toMatchObject({ helloProbePassed: true });
      expect(refresh).toHaveBeenCalledOnce();
      f.session.close.mockRejectedValue(new Error("Cleanup not confirmed"));
      refresh.mockClear();
      await expect(probeQualifiedAcpxEnvironment({ ...options, runtimeDirectory, agent: "grok", environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: "selected-grok-login" }, onGrokCredentialRefresh: refresh })).rejects.toThrow("Cleanup not confirmed");
      expect(refresh).not.toHaveBeenCalled();
    } finally { await rm(runtimeDirectory, { recursive: true, force: true }); }
  });
});
