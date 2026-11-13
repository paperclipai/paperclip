import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type {
  PaperclipPluginManifestV1,
  PluginRecord,
} from "../../../packages/shared/src/types/plugin.js";
import { pollUntil } from "../api.js";
import { createPreviewFixture } from "./external-plugin-fixture.js";
import { identityWorker } from "./identity-support.js";
export interface CustodyReceipt {
  companyId: string;
  agentId: string;
  operationId: string;
  version: number;
  phase: string;
  hadOwnedSecret: boolean;
  returnedOwnedSecret: boolean;
}
export interface CustodyState {
  ownerAgentId: string;
  receipts: CustodyReceipt[];
}
export function custodyManifest(key: string): PaperclipPluginManifestV1 {
  return {
    id: key,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Owned instance custody fixture",
    description: "Disposable agent lifecycle custody boundary",
    author: "Paperclip evaluation fixture",
    categories: ["automation"],
    capabilities: ["agents.lifecycle.manage", "api.routes.register"],
    agentLifecycle: true,
    entrypoints: { worker: "./dist/worker.js" },
    apiRoutes: [
      {
        routeKey: "custody",
        method: "GET",
        path: "/custody",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
      {
        routeKey: "release",
        method: "POST",
        path: "/release",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ],
  };
}
export function custodyRoundtrip(
  input: unknown,
  companyId: string,
  agentId: string,
  resumeOperationId: string,
  version: number,
) {
  const value = input as Partial<CustodyState> | undefined;
  return (
    !!value &&
    value.ownerAgentId === agentId &&
    Array.isArray(value.receipts) &&
    value.receipts.some(
      (row) =>
        row?.companyId === companyId &&
        row.agentId === agentId &&
        row.phase === "preparing" &&
        row.hadOwnedSecret === false &&
        row.returnedOwnedSecret === true,
    ) &&
    value.receipts.some(
      (row) =>
        row?.companyId === companyId &&
        row.agentId === agentId &&
        row.phase === "resuming" &&
        row.operationId === resumeOperationId &&
        row.version === version &&
        row.hadOwnedSecret === true &&
        row.returnedOwnedSecret === false,
    )
  );
}
export interface PublicCustodyAgent {
  id: string;
  companyId: string;
  lifecycleState: string;
  lifecycleVersion?: number;
  lifecycleError?: string | null;
}
export function publicResumeCustodyReceipt(input: {
  companyId: string; agentId: string; paused: PublicCustodyAgent;
  resumed: PublicCustodyAgent; ready: PublicCustodyAgent;
  before: CustodyState; after: CustodyState;
}): CustodyReceipt | undefined {
  const { companyId, agentId, paused, resumed, ready, before, after } = input;
  const sameAgent = (agent: PublicCustodyAgent) => agent?.id === agentId && agent.companyId === companyId && !agent.lifecycleError;
  if (!sameAgent(paused) || !sameAgent(resumed) || !sameAgent(ready)
    || paused.lifecycleState !== "paused" || !Number.isSafeInteger(paused.lifecycleVersion) || paused.lifecycleVersion! < 1 || !Number.isSafeInteger(paused.lifecycleVersion! + 2)) return;
  const version = paused.lifecycleVersion! + 1;
  if (!(resumed.lifecycleState === "resuming" && resumed.lifecycleVersion === version
    || resumed.lifecycleState === "ready" && resumed.lifecycleVersion === version + 1)
    || ready.lifecycleState !== "ready" || ready.lifecycleVersion !== version + 1
    || before?.ownerAgentId !== agentId || after?.ownerAgentId !== agentId
    || !Array.isArray(before.receipts) || !Array.isArray(after.receipts)
    || !isDeepStrictEqual(after.receipts.slice(0, before.receipts.length), before.receipts)
    || after.receipts.some(row => !row || row.companyId !== companyId)) return;
  const priorOperations = new Set(before.receipts.map(row => row.operationId));
  const receipts = after.receipts.filter(row => row.agentId === agentId && row.phase === "resuming" && !priorOperations.has(row.operationId));
  if (!receipts.length || receipts.some(row => typeof row.operationId !== "string" || !row.operationId
    || row.version !== version || row.hadOwnedSecret !== true || row.returnedOwnedSecret !== false)
    || new Set(receipts.map(row => row.operationId)).size !== 1) return;
  const receipt = receipts[0]!;
  if (!custodyRoundtrip(after, companyId, agentId, receipt.operationId, receipt.version)) return;
  return receipt;
}
/** Vetted synthetic plugin uses the supported lifecycle result, not a private
 * secret-service write. Its public receipt exposes identities and booleans only. */
export async function createInstanceCustody(
  ctx: ChatCatalogContext,
  value: string,
) {
  const scaffold = await createPreviewFixture(ctx),
    seed = path.join(scaffold.packageRoot, "custody-input.private");
  let installedId: string | undefined, ownerAgentId: string | undefined;
  const apiPath = (route: string) =>
    `/api/plugins/${installedId}/api/${route}?companyId=${ctx.input.fixtures.company.id}`;
  async function read() {
    return ctx.input.api.get<CustodyState>(apiPath("custody"));
  }
  async function lifecycle(agentId: string, expected: string) {
    return pollUntil({
      label: `owned custody lifecycle ${expected}`,
      deadlineAt: Date.now() + 90000,
      intervalMs: 500,
      load: () =>
        ctx.input.api.get<PublicCustodyAgent>(`/api/agents/${agentId}`),
      accept: (row) => row.lifecycleState === expected,
      reject: (row) =>
        row.lifecycleError
          ? "Owned custody lifecycle failed; diagnostic withheld"
          : undefined,
    });
  }
  async function close() {
    try {
      if (installedId && ownerAgentId) {
        await ctx.input.api.post(apiPath("release"), {});
        await ctx.input.api.post(`/api/agents/${ownerAgentId}/pause`);
        await lifecycle(ownerAgentId, "paused");
      }
      if (installedId)
        await ctx.input.api.delete(`/api/plugins/${installedId}`, {
          allowNotFound: true,
        });
    } finally {
      await scaffold.close();
    }
  }
  try {
    await writeFile(seed, value, { mode: 0o600 });
    const manifest = custodyManifest(scaffold.key),
      sdk = new URL(
        "../../../packages/plugins/sdk/dist/index.js",
        import.meta.url,
      ).href;
    const worker = `import {definePlugin,runWorker} from ${JSON.stringify(sdk)};import {readFile} from 'node:fs/promises';const expected=await readFile(${JSON.stringify(seed)},'utf8');const company=${JSON.stringify(ctx.input.fixtures.company.id)},receipts=[];let ownerAgentId='',release=false;const plugin=definePlugin({async setup(){},async onHealth(){return {status:'ok'}},async onAgentLifecycle(input){if(input.companyId!==company)return {operationId:input.operationId,version:input.version,status:'complete'};if(!ownerAgentId&&input.phase==='preparing')ownerAgentId=input.agentId;const owned=input.agentId===ownerAgentId,hadOwnedSecret=input.instanceSecrets?.custody_probe===expected,returnedOwnedSecret=owned&&input.phase==='preparing';if(receipts.length>=64)throw new Error('Owned lifecycle receipt bound exceeded');receipts.push({companyId:input.companyId,agentId:input.agentId,operationId:input.operationId,version:input.version,phase:input.phase,hadOwnedSecret,returnedOwnedSecret});return {operationId:input.operationId,version:input.version,status:'complete',...(owned&&release?{instanceSecrets:{custody_probe:null}}:returnedOwnedSecret?{instanceSecrets:{custody_probe:expected}}:{})};},async onApiRequest(input){if(input.companyId!==company||input.actor.actorType!=='user')throw new Error('Owned custody board scope required');if(input.routeKey==='release'&&input.method==='POST')release=true;return {body:{ownerAgentId,receipts}}}});export default plugin;runWorker(plugin,import.meta.url);\n`;
    await writeFile(
      path.join(scaffold.packageRoot, "dist/manifest.js"),
      `export default ${JSON.stringify(manifest)};\n`,
    );
    await writeFile(path.join(scaffold.packageRoot, "dist/worker.js"), worker);
    await ctx.input.evidence("chat-catalog-owned-custody-package.json", {
      synthetic: true,
      manifestSha256: createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex"),
      workerSha256: createHash("sha256").update(worker).digest("hex"),
      operatorChannel: "public-board-local-package-install",
    });
    const installed = await ctx.input.api.post<PluginRecord>(
      "/api/plugins/install",
      { packageName: scaffold.packageRoot, isLocalPath: true },
    );
    installedId = installed.id;
    await pollUntil({
      label: "owned custody real plugin admission",
      deadlineAt: Date.now() + 45000,
      intervalMs: 500,
      load: () =>
        ctx.input.api.get<PluginRecord>(`/api/plugins/${installed.id}`),
      accept: (row) => row.status === "ready",
      reject: (row) =>
        row.status === "error"
          ? "Owned custody package admission failed; detail withheld"
          : undefined,
    });
    const riley = await identityWorker(ctx, "Riley");
    ownerAgentId = riley.id;
    await lifecycle(riley.id, "ready");
    await ctx.input.api.post(`/api/agents/${riley.id}/pause`);
    const paused = await lifecycle(riley.id, "paused");
    const before = await read();
    const resumeDeadlineAt = Date.now() + 90000;
    const resumed = await ctx.input.api.post<PublicCustodyAgent>(`/api/agents/${riley.id}/resume`);
    const observed = await pollUntil({
      label: "owned custody public resume and real operation receipt",
      deadlineAt: resumeDeadlineAt,
      intervalMs: 500,
      load: async () => {
        const [ready, after] = await Promise.all([
          ctx.input.api.get<PublicCustodyAgent>(`/api/agents/${riley.id}`), read(),
        ]);
        return { ready, after };
      },
      accept: ({ ready, after }) => Date.now() < resumeDeadlineAt && !!publicResumeCustodyReceipt({ companyId: ctx.input.fixtures.company.id, agentId: riley.id, paused, resumed, ready, before, after }),
      reject: ({ ready }) => ready.lifecycleError ? "Owned custody resume failed; diagnostic withheld" : undefined,
    });
    const receipt = publicResumeCustodyReceipt({ companyId: ctx.input.fixtures.company.id, agentId: riley.id, paused, resumed, ...observed, before });
    if (Date.now() >= resumeDeadlineAt || !receipt) throw new Error("Actual public resume custody receipt is missing, late or unqualified");
    await rm(seed, { force: true });
    return {
      pluginId: installed.id,
      rileyId: riley.id,
      resumeOperationId: receipt.operationId,
      resumeVersion: receipt.version,
      seedRemoved: true as const,
      read,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
