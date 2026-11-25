import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { extendedHarnessProfiles } from "../catalog.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import type { RuntimeAgent } from "./runtime-support.js";
import { ownedInstalledTarget } from "./privileged-installed.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat, companionPhase } from "./privileged-support.js";
const targets = new WeakMap<ChatCatalogContext, Awaited<ReturnType<typeof ownedInstalledTarget>>>();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export function gradeProvisionRuntime(value: unknown) {
  const c = checks(), o = privilegedObservation(value); c.add("actual-release-provision-evidence", !!o, "Actual installed release asset identity and genuine native Pi execution are required."); if (!o) return c.result();
  c.add("owned-release-matched-assets", o.state.assetsInitiallyAbsent === true && o.state.provisionerSucceeded === true
    && typeof o.state.provisionerSha256 === "string" && typeof o.state.nativeClosureSha256 === "string"
    && o.state.releaseVersion === o.state.healthVersion && o.state.assetPathOwned === true,
    "The public operator provisioner installs into the actual source release's owned server package, preserving exact provisioner and closure identities.");
  c.add("qualified-running-pi-agent", o.state.piAgentConfigurationVerified === true && o.state.piRunId != null
    && o.state.piArtifactMatches === true && o.runs.some(run => run.id === o.state.piRunId && run.agentId === o.state.piAgentId
      && run.status === "succeeded" && run.runtimeMode === "native") && o.runs.length === 3,
    "A separately declared Pi worker performs genuine native work with independently read file bytes; download alone never qualifies it.");
  const guidance = String(o.state.guidance ?? "");
  c.add("supported-operator-guidance", /runtime\s+setup\s+pi|runtime.*(?:setup|install)/i.test(guidance) && /operator|terminal|admin/i.test(guidance)
    && !/curl.*latest|I (?:have |successfully )?installed/i.test(guidance), "The actual initial response uses the supported operator path without arbitrary latest binaries or premature success.");
  const phase = o.state.provisionReport as { attributed?: boolean; reply?: string } | undefined;
  c.add("truthful-running-result", phase?.attributed === true && /Pi/i.test(phase.reply ?? "") && /run|execut|qualif/i.test(phase.reply ?? ""),
    "A separate actual native reply interprets the factual provisioning and real worker receipt.");
  return c.result();
}
const provision = privilegedDefinition("instance-operations.provision-runtime", "privileged-provision", {
  async setup(ctx) {
    const target = await ownedInstalledTarget(ctx), envName = target.receipt.piCredentialEnv;
    if (!envName || !ctx.input.privateInputs?.read(envName)) throw new Error("Real Pi qualification requires the explicitly declared private OpenRouter credential environment reference");
    const vendor = path.resolve(target.server, "../vendor/paperclip-runner"), assets = path.join(vendor, "provider-assets/pi", `${process.platform}-${process.arch}`);
    let exists = false; try { exists = (await stat(assets)).isDirectory(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (exists) throw new Error("Canonical provision context requires this owned release to lack Pi assets; existing assets are never removed by the fixture");
    const entry = await realpath(path.join(vendor, "cli/provision-pi.cjs"));
    if (!entry.startsWith(target.root + path.sep)) throw new Error("Pi provisioner is not inside the intended owned installed server");
    targets.set(ctx, target);
    return { releaseVersion: target.receipt.version, assetsInitiallyAbsent: true, provisionerSha256: sha(await readFile(entry)),
      piProfile: "runner-acpx-pi", piModel: extendedHarnessProfiles.find(p => p.id === "runner-acpx-pi")!.model };
  },
  async act(ctx, state) {
    const initial = await settlePrivilegedChat(ctx); state.guidance = initial.reply; const target = targets.get(ctx)!;
    await target.command(["runtime", "setup", "pi"], 900_000); state.provisionerSucceeded = true;
    const closure = await realpath(path.resolve(target.server, "../vendor/paperclip-runner/provider-assets/pi", `${process.platform}-${process.arch}`, "native-closure.json"));
    state.assetPathOwned = closure.startsWith(target.root + path.sep); if (!state.assetPathOwned) throw new Error("Provisioned Pi closure escapes the intended installation");
    state.nativeClosureSha256 = sha(await readFile(closure));
    // Credentials remain exclusively in the public encrypted secret boundary.
    const token = ctx.input.privateInputs?.read(target.receipt.piCredentialEnv!); if (!token) throw new Error("Missing selected private Pi credential"); ctx.input.privateSecrets?.push(token);
    const company = ctx.input.fixtures.company.id;
    const secret = await ctx.input.api.postSensitive<{ id: string }>(`/api/companies/${company}/secrets`, { name: "Owned Pi qualification", key: "OPENROUTER_API_KEY", value: token });
    const profile = extendedHarnessProfiles.find(p => p.id === "runner-acpx-pi")!;
    const config = profile.buildAgent({ environmentId: ctx.input.fixtures.environment.id, environmentFixtureId: "local", workspacePath: ctx.input.workspacePath,
      secretRefs: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } }, executionId: ctx.input.nonce });
    const agent = await ctx.input.api.post<RuntimeAgent>(`/api/companies/${company}/agents`, { ...config, name: "Pi qualification worker", reportsTo: ctx.input.fixtures.agent.id,
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } } }); state.piAgentId = agent.id;
    const ready = await pollUntil({ label: "Actual release Pi worker readiness", deadlineAt: Date.now() + 90000,
      load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${agent.id}`), accept: a => a.lifecycleState === "ready" });
    const saved = ready.adapterConfig as { provider?: string; acpxAgent?: string; model?: string };
    state.piAgentConfigurationVerified = ready.adapterType === "paperclip_runner" && saved.provider === "acpx" && saved.acpxAgent === "pi" && saved.model === profile.model;
    for (const scope of [{ scopeType: "company", scopeId: company }, { scopeType: "agent", scopeId: agent.id }])
      await ctx.input.api.post(`/api/companies/${company}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const marker = `Pi native qualification ${ctx.input.nonce}`;
    const task = await ctx.input.api.post<Entity>(`/api/companies/${company}/issues`, { title: "Owned release Pi readiness", status: "todo", assigneeAgentId: agent.id,
      description: `Write pi-qualified.txt in your admitted workspace containing exactly ${JSON.stringify(marker)}, then complete this task. Do not create another task or external side effect.` });
    const result = await pollUntil({ label: "Real release-matched native Pi task", deadlineAt: Date.now() + 180000,
      load: async () => ({ task: await ctx.input.api.get<Entity>(`/api/issues/${task.id}`), runs: await ctx.allRuns() }),
      accept: o => o.task.status === "done" && o.runs.length === 2 && o.runs.every(r => r.status === "succeeded"),
      reject: o => o.runs.some(r => ["failed", "timed_out", "cancelled"].includes(r.status)) ? "Actual Pi qualification native run failed" : undefined });
    const run = result.runs.find(r => r.agentId === agent.id)!; state.piRunId = run.id;
    const file = await ctx.input.api.get<{ content?: { data?: string }; resource?: { workspaceKind?: string } }>(`/api/issues/${task.id}/file-resources/content?workspace=execution&path=pi-qualified.txt`);
    state.piArtifactMatches = file.content?.data?.trim() === marker && file.resource?.workspaceKind === "execution_workspace";
    const health = await ctx.input.api.get<{ version?: string }>("/api/health"); state.healthVersion = health.version;
    const receipt = { releaseVersion: state.releaseVersion, provisionerSha256: state.provisionerSha256, nativeClosureSha256: state.nativeClosureSha256,
      profile: profile.id, model: profile.model, piAgentId: agent.id, piRunId: run.id, piRunStatus: run.status, runtimeMode: run.runtimeMode,
      exactFileVerified: state.piArtifactMatches, qualificationScope: "one real native task on the actual owned installed source target" };
    await ctx.input.evidence("chat-catalog-pi-provision-and-native-readiness.json", receipt);
    const message = `The operator provisioned the intended installation and ran its separate Pi qualification worker. These are the observed facts; please describe what they establish and their limits:\n\n${JSON.stringify(receipt)}`;
    await sendChatMessage(ctx.input.page, message); state.provisionReport = await companionPhase(ctx, result.runs.map(r => r.id), message);
  }, grade: gradeProvisionRuntime, async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
provision.expectedRunCount = 3; provision.expectedHumanMessageCount = 2; provision.attemptTimeoutMs = 1_440_000;
provision.coverageGaps = [];
provision.installedSource = "published-global-npm";
provision.requiredCredentials = ["OPENROUTER_API_KEY"];
provision.sourceFiles = [...provision.sourceFiles, "chat-catalog-domains/privileged-installed.ts", "../../cli/src/commands/runtime.ts", "../../packages/paperclip-runner/scripts/provision-pi.mjs"];
export const privilegedProvisionCases = [provision];
