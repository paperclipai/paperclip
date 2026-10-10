import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { COPILOT_TASK_ORIENTATION_INSTRUCTIONS } from "./copilot-profile.js";
import { AcpxRuntimeHost, type AcpxRuntimeHostDependencies, type AcpxRuntimePortOpenOptions } from "./runtime-host.js";

it("reports missing Copilot authentication before spawn and releases admission ownership for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-copilot-auth-admission-"));
  const runtimeDirectory = join(root, "runtime");
  const workingDirectory = join(root, "workspace");
  await Promise.all([mkdir(runtimeDirectory), mkdir(workingDirectory), mkdir(join(root, "provider"))]);
  const openRuntime = vi.fn(async (_options: AcpxRuntimePortOpenOptions): Promise<never> => {
    throw new Error("fixture stopped before provider spawn");
  });
  const close = vi.fn(async () => {});
  const openCommand = vi.fn(async () => ({ spawn: () => { throw new Error("must not spawn"); }, close }));
  const dependencies: AcpxRuntimeHostDependencies = {
    verifyInstallation: async profile => ({ commandDigest: profile.commandDigest,
      agentServerPackageJsonPath: join(root, "provider/package.json"), agentRuntimePackageJsonPath: null, openCommand }),
    openRuntime, reportRetainedCleanupFailure: () => {},
  };
  const options = { agent: "copilot" as const, model: "explicit-model", normalizedSessionId: "copilot-auth-test",
    runtimeDirectory, workingDirectory, providerPolicy: { readOnly: false } };
  try {
    await expect(AcpxRuntimeHost.open({ ...options, environment: { GH_TOKEN: "ambient-forbidden", GITHUB_TOKEN: "ambient-forbidden" } }, dependencies))
      .rejects.toMatchObject({ code: "COPILOT_AUTH_REQUIRED", retryable: false });
    expect(openCommand).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
    await expect(AcpxRuntimeHost.open({ ...options, environment: { COPILOT_GITHUB_TOKEN: "explicit-fixture-only", GH_TOKEN: "ambient-forbidden" } }, dependencies))
      .rejects.toThrow("fixture stopped before provider spawn");
    expect(openRuntime).toHaveBeenCalledOnce();
    const environment = openRuntime.mock.calls[0]![0].launchEnvironment;
    expect(environment.COPILOT_GITHUB_TOKEN).toBe("explicit-fixture-only");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(close).toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not refresh Copilot instructions for a contender rejected by the lifetime lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-copilot-instruction-owner-"));
  const runtimeDirectory = join(root, "runtime");
  const workingDirectory = join(root, "workspace");
  await Promise.all([mkdir(runtimeDirectory), mkdir(workingDirectory), mkdir(join(root, "provider"))]);
  let releaseWinner!: () => void;
  const winnerGate = new Promise<void>(resolve => { releaseWinner = resolve; });
  let notifyWinner!: () => void;
  const winnerEntered = new Promise<void>(resolve => { notifyWinner = resolve; });
  let instructionPath = "";
  const openRuntime = vi.fn(async (options: AcpxRuntimePortOpenOptions): Promise<never> => {
    instructionPath = join(options.launchEnvironment.COPILOT_HOME!, "copilot-instructions.md");
    notifyWinner();
    await winnerGate;
    throw new Error("fixture stops before native process launch");
  });
  const dependencies: AcpxRuntimeHostDependencies = {
    verifyInstallation: async profile => ({
      commandDigest: profile.commandDigest,
      agentServerPackageJsonPath: join(root, "provider/package.json"), agentRuntimePackageJsonPath: null,
      openCommand: async () => ({ spawn: () => { throw new Error("must not spawn"); }, close: async () => {} }),
    }),
    openRuntime, reportRetainedCleanupFailure: () => {},
  };
  const options = {
    agent: "copilot" as const, model: "explicit-model", permissionMode: "approve-reads" as const,
    normalizedSessionId: "same-native-session", runtimeDirectory, workingDirectory,
    providerPolicy: { readOnly: false }, environment: { COPILOT_GITHUB_TOKEN: "synthetic-fixture" },
  };
  const composed = (value: string) => `${value}\n\n# Paperclip task orientation\n${COPILOT_TASK_ORIENTATION_INSTRUCTIONS}\n`;
  const winner = AcpxRuntimeHost.open({ ...options, systemInstructions: "Winner instructions." }, dependencies);
  // Attach the rejection handler before deliberately releasing the failed launch.
  const winnerResult = expect(winner).rejects.toThrow("fixture stops before native process launch");
  try {
    await winnerEntered;
    expect(await readFile(instructionPath, "utf8")).toBe(composed("Winner instructions."));
    await expect(AcpxRuntimeHost.open({ ...options, systemInstructions: "Losing contender." }, dependencies))
      .rejects.toThrow("already has an active lease");
    expect(openRuntime).toHaveBeenCalledOnce();
    expect(await readFile(instructionPath, "utf8")).toBe(composed("Winner instructions."));
    releaseWinner();
    await winnerResult;
    await expect(AcpxRuntimeHost.open({ ...options, systemInstructions: "New owner instructions." }, dependencies))
      .rejects.toThrow("fixture stops before native process launch");
    expect(await readFile(instructionPath, "utf8")).toBe(composed("New owner instructions."));
    await expect(AcpxRuntimeHost.open({ ...options, environment: {}, systemInstructions: "Unauthenticated admission." }, dependencies))
      .rejects.toMatchObject({ code: "COPILOT_AUTH_REQUIRED" });
    expect(await readFile(instructionPath, "utf8")).toBe(composed("New owner instructions."));
  } finally {
    releaseWinner();
    await winnerResult;
    await rm(root, { recursive: true, force: true });
  }
});
