import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCapabilityRunnerdProviderEnvironment,
  createRunnerdCodexTransport,
  runnerdLaunchProfileInternals,
} from "./runnerd-codex-transport.js";

// At qualification Antigravity's profile flips from pending to qualified; no
// other code changes. These cases simulate that declaration and prove the
// transport's Antigravity refusals key on a candidate grant only, so a
// released profile without a grant takes the general qualified path.
const qualification = vi.hoisted(() => ({ antigravity: "pending" as "pending" | "qualified" }));
vi.mock("../drivers/acpx/capability-profiles.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../drivers/acpx/capability-profiles.js")>();
  const profiles = Object.create(actual.ACPX_CAPABILITY_PROFILES) as Record<string, unknown>;
  Object.defineProperty(profiles, "antigravity", {
    enumerable: true,
    get: () => ({ ...actual.ACPX_CAPABILITY_PROFILES.antigravity, qualification: qualification.antigravity }),
  });
  return { ...actual, ACPX_CAPABILITY_PROFILES: profiles };
});

const identity = {
  runnerInstanceId: "runner-released", environmentLeaseId: "lease-released", runId: "run-released",
  normalizedSessionId: "session-released", turnId: "turn-released", itemId: "item-released",
};
const digest = (fill: string) => `sha256:${fill.repeat(64)}`;

async function withRoot<T>(label: string, work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `antigravity-released-${label}-`));
  try { return await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

afterEach(() => { qualification.antigravity = "pending"; });

describe("released Antigravity without a candidate grant", () => {
  it("is refused while pending and admitted as an ordinary transport once released", async () => {
    await withRoot("admission", async root => {
      const options = { provider: "acpx" as const, acpxAgent: "antigravity" as const, stateDirectory: root };
      expect(() => createRunnerdCodexTransport(options)).toThrow("explicit evaluation opt-in");
      qualification.antigravity = "qualified";
      // The candidate-only shape limits (warm lifecycle, active-turn and
      // conversation resume) do not apply.
      for (const change of [{}, { lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 1000 } },
        { resumeActiveTurnId: "turn-active" },
        { resumeProviderSession: { driverSessionId: "driver-retained" } }]) {
        const owner = createRunnerdCodexTransport({ ...options, ...change });
        // The candidate-only conversation-resume preparation is not installed.
        expect(owner.transport.prepareConversationResume).toBeUndefined();
        await owner.transport.close();
      }
      // A preconfigured home stays limited to Claude and Codex for every ACPX
      // agent; that general rule, not the candidate one, refuses it.
      expect(() => createRunnerdCodexTransport({ ...options, homeMode: "preconfigured" }))
        .toThrow("preconfigured_home_unsupported_provider");
    });
  });

  it("reaches the general durable runner recovery instead of the candidate refusal", async () => {
    qualification.antigravity = "qualified";
    await withRoot("recovery", async root => {
      const owner = createRunnerdCodexTransport({ provider: "acpx", acpxAgent: "antigravity", stateDirectory: root });
      try {
        // A recovery read with no saved PRP identity fails at the first step
        // of the general recovery, after the candidate refusal would have run.
        const failure = owner.transport.request("thread/read", { threadId: "thread-released", includeTurns: false });
        await expect(failure).rejects.toThrow("PRP provider resume state is unavailable");
        await expect(failure).rejects.not.toThrow("candidate");
      } finally { await owner.transport.close(); }
    });
  });

  it("builds a remote launch profile without startup authority", () => {
    qualification.antigravity = "qualified";
    const profile = runnerdLaunchProfileInternals.acpxRunnerLaunchProfile({
      provider: "acpx", acpxAgent: "antigravity", runnerFilesystemRoot: "/guest",
      providerNodeCommandSha256: digest("b"), acpxSidecarSha256: digest("c"), providerPackAuthorityDigest: digest("d"),
    }, "/guest/node", "/guest/acpx-runtime-sidecar.cjs");
    expect(profile).toEqual({
      authorityDigest: digest("d"), command: "/guest/node", commandSha256: digest("b"),
      sidecarScript: "/guest/acpx-runtime-sidecar.cjs", sidecarScriptSha256: digest("c"),
    });
    expect(profile).not.toHaveProperty("candidateAdmission");
  });

  it("forwards the governed replacement recovery policy to the sidecar", () => {
    qualification.antigravity = "qualified";
    const environment = createCapabilityRunnerdProviderEnvironment({
      provider: "acpx",
      options: { provider: "acpx", acpxAgent: "antigravity", providerRecoveryPolicy: "allow_replacement_after_governed_wait" },
      identity, codexHome: "/isolated/home", runtimeContextPath: "/isolated/context.json", hasRuntimeContext: false,
    });
    expect(environment.PAPERCLIP_ACPX_PROVIDER_RECOVERY_POLICY).toBe("allow_replacement_after_governed_wait");
  });
});
