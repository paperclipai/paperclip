import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks } from "./internal-support.js";
import { ownedInstalledTarget } from "./privileged-installed.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat, companionPhase } from "./privileged-support.js";
const targets = new WeakMap<ChatCatalogContext, Awaited<ReturnType<typeof ownedInstalledTarget>>>();
export function gradeInstalledUpdate(value: unknown) {
  const c = checks(), o = privilegedObservation(value); c.add("installed-update-evidence", !!o, "Actual pinned source installation and supported operator result are required."); if (!o) return c.result();
  c.add("exact-installed-operation", o.state.installMode === "global-npm" && o.state.registryIntegrityMatched === true
    && o.state.updateExecuted === true && o.state.installedVersion === o.state.targetVersion && o.state.healthVersion === o.state.targetVersion
    && o.state.healthReady === true && o.state.serviceRestarted === true && typeof o.state.finalCliSha256 === "string",
    "The public updater changes only the owned installed prefix to its exact published integrity and the restarted source service reports that version ready.");
  c.add("channel-and-rollback-guidance", /install|channel|npm|managed/i.test(String(o.state.guidance)) && /operator|admin|terminal/i.test(String(o.state.guidance))
    && !/I (?:have |successfully )?updated|newest version is|latest version is/i.test(String(o.state.guidance))
    && o.state.rollbackVersion === o.state.originalVersion, "The initial answer assigns installation authority correctly; the concrete prior-version reinstall is retained for this npm channel.");
  const report = o.state.updateReport as { attributed?: boolean; reply?: string } | undefined;
  c.add("native-result-report", report?.attributed === true && !!o.state.targetVersion && report.reply?.includes(String(o.state.targetVersion)) === true
    && /health|ready|restart/i.test(report.reply), "The actual follow-up native reply interprets the real version and service receipt.");
  return c.result();
}
const update = privilegedDefinition("instance-operations.update-instance", "privileged-update", {
  async setup(ctx) { const target = await ownedInstalledTarget(ctx); const r = target.receipt;
    if (!r.targetVersion || !r.targetIntegrity || r.targetVersion === r.version) throw new Error("Installed update requires distinct exact supported targetVersion and published sha512 targetIntegrity");
    // Require the actual npm global layout; managed/source installs use different contracts.
    if (!target.cli.includes("/lib/node_modules/paperclipai/dist/index.js")) throw new Error("This authored update lane requires an owned global-npm installation");
    targets.set(ctx, target); return { originalVersion: r.version, targetVersion: r.targetVersion, rollbackVersion: r.version,
      originalCliSha256: r.cliSha256, sourceServerSha256: r.serverSha256, installationOwned: true }; },
  async act(ctx, state) { const initial = await settlePrivilegedChat(ctx); state.guidance = initial.reply;
    const target = targets.get(ctx)!;
    const check = JSON.parse(await target.command(["update", "--version", target.receipt.version, "--check", "--json"]));
    state.installMode = check.mode;
    if (check.mode !== "global-npm") throw new Error("Public updater does not identify the expected npm channel");
    // npm independently verifies registry integrity during its actual install; retain the pinned expected identity too.
    const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
    const metadata = JSON.parse((await promisify(execFile)("npm", ["view", `paperclipai@${target.receipt.targetVersion}`, "dist.integrity", "--json", "--registry=https://registry.npmjs.org"],
      { env: { ...target.environment, NPM_CONFIG_USERCONFIG: "/dev/null" }, timeout: 30000, maxBuffer: 65536 })).stdout);
    state.registryIntegrityMatched = metadata === target.receipt.targetIntegrity;
    if (!state.registryIntegrityMatched) throw new Error("Published target integrity differs from the explicit supported artifact pin");
    const output = await target.command(["update", "--version", target.receipt.targetVersion!, "--yes", "--json"]);
    const start = output.lastIndexOf("\n{"); const result = JSON.parse(start >= 0 ? output.slice(start + 1) : output);
    state.updateExecuted = result.action === "update" && result.targetVersion === target.receipt.targetVersion;
    const manifest = JSON.parse(await readFile(new URL("../package.json", `file://${target.cli}`), "utf8"));
    state.installedVersion = manifest.version; state.finalCliSha256 = createHash("sha256").update(await readFile(target.cli)).digest("hex");
    await ctx.input.restart(); state.serviceRestarted = true;
    const health = await ctx.input.api.get<{ version?: string; status?: string }>("/api/health"); state.healthVersion = health.version; state.healthReady = health.status === "ok";
    const receipt = { originalVersion: state.originalVersion, installedVersion: state.installedVersion, healthVersion: state.healthVersion,
      healthReady: state.healthReady, installationChannel: "global-npm", rollbackCommand: `npm install -g paperclipai@${state.originalVersion} (same owned prefix only)`, registryIntegrityMatched: state.registryIntegrityMatched };
    await ctx.input.evidence("chat-catalog-installed-update.json", receipt);
    await ctx.input.page.goto(`${ctx.input.api.baseURL}/${ctx.input.fixtures.company.issuePrefix}/chats/${ctx.input.fixtures.agent.id}`);
    const message = `The operator applied the owned installation update and recorded these facts. Please describe the observed result and limits:\n\n${JSON.stringify(receipt)}`;
    await sendChatMessage(ctx.input.page, message); state.updateReport = await companionPhase(ctx, initial.runs.map(run => run.id), message);
  }, grade: gradeInstalledUpdate, async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
update.coverageGaps = [];
update.installedSource = "published-global-npm";
update.expectedRunCount = 2; update.expectedHumanMessageCount = 2; update.attemptTimeoutMs = 720_000;
update.sourceFiles = [...update.sourceFiles, "chat-catalog-domains/privileged-installed.ts", "../../cli/src/commands/update.ts", "installed-release.ts"];
export const privilegedUpdateCases = [update];
