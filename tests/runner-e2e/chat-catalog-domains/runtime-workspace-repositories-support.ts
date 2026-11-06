import { createHash } from "node:crypto";
import { readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { executionWorkspaceRepositories } from "../../../packages/db/src/schema/execution_workspace_repositories.js";
export type RepositoryReceipt = typeof executionWorkspaceRepositories.$inferSelect;
export interface RepositoryWorkspace { issueId: string; workspace: { id: string; companyId: string; cwd: string; providerType?: string }; repositories: RepositoryReceipt[] }
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Require changed header/navigation markup on both sides, not a comment or
 * assistant claim that happens to contain the word header. */
export function changedHeaderMarkup(diff: string) {
  const changed = diff.split("\n").filter(line => /^[+-](?![+-])/.test(line) && !/^[+-]\s*(?:<!--|\/\/|\/\*|\*)/.test(line));
  const markup = /<(?:header|h1|nav)\b|(?:className|class|id)=["'][^"']*(?:header|navbar)[^"']*["']/i;
  return changed.some(line => line.startsWith("-") && markup.test(line)) && changed.some(line => line.startsWith("+") && markup.test(line));
}
/** Read-only local evidence; this never clones, authenticates, changes Git or runs repository code. */
export async function inspectCheckout(view: RepositoryWorkspace, row: RepositoryReceipt) {
  const root = await realpath(view.workspace.cwd), checkout = path.resolve(root, row.relativePath);
  if (!row.relativePath || path.isAbsolute(row.relativePath) || !checkout.startsWith(`${root}${path.sep}`) || await realpath(checkout) !== checkout
    || !(await lstat(path.join(checkout, ".git"))).isDirectory() || await realpath(path.join(checkout, ".git")) !== path.join(checkout, ".git")) throw new Error("Repository observation escaped the actual task workspace");
  const exec = promisify(callback);
  const git = async (...args: string[]) => (await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", checkout, ...args], {
    timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
  })).stdout.trim();
  const origin = await git("config", "--get", "remote.origin.url"), head = await git("rev-parse", "HEAD");
  const ownership = JSON.parse(await readFile(path.join(checkout, ".git", "paperclip-workspace-owner.json"), "utf8")) as { repositoryId: string; pinnedCommit: string };
  const paths = (await git("ls-tree", "-r", "--name-only", "HEAD")).split("\n").filter(Boolean);
  const sample = paths.find(file => /(?:^|\/)(?:index\.html|README(?:\.md)?)$/i.test(file)) ?? paths[0];
  if (!sample || sample.startsWith("/") || sample.split("/").includes("..")) throw new Error("Actual checkout has no safe tracked evidence file");
  const samplePath = path.join(checkout, sample), sampleStat = await lstat(samplePath);
  if (!sampleStat.isFile() || sampleStat.isSymbolicLink() || sampleStat.size > 1048576 || !(await realpath(samplePath)).startsWith(`${checkout}${path.sep}`)) throw new Error("Tracked evidence file is not a bounded contained regular file");
  const bytes = await readFile(samplePath);
  const config = await readFile(path.join(checkout, ".git", "config"), "utf8");
  const diff = await git("diff", "--no-ext-diff", "--no-textconv", "--", ".");
  return { origin, head, ownership, trackedFile: sample, trackedBytes: bytes.length, trackedSha256: digest(bytes),
    headerChanged: changedHeaderMarkup(diff), diffSha256: digest(diff),
    credentialConfigClean: !/https?:\/\/[^\s/]*@|(?:token|password|authorization|extraheader)\s*=/i.test(config),
    // Raw source/diff is inspected before redacted diagnostic projection.
    rawConfig: config, rawSample: bytes.toString("utf8"), rawDiff: diff };
}
/** Actual workload code executes with its OWN run capability. It prints only
 * closed booleans; it never prints credentials or a broker response body. */
export const workloadBoundaryCode = `const e=process.env; const base=e.PAPERCLIP_API_URL; const api=e.PAPERCLIP_API_KEY; const capability=e.PAPERCLIP_GITHUB_BROKER_TOKEN; if(!base||!api||!capability)throw Error('workload authority unavailable'); const root=new URL(base); const secret=new URL('/api/agents/me/secrets/GITHUB_TOKEN/value',root); const broker=new URL('/runtime-tools/github/credentials',e.PAPERCLIP_GITHUB_BROKER_URL||root); const brokerAuth=e.PAPERCLIP_GITHUB_BRIDGE_TOKEN||api||capability; const list=await fetch(new URL('/api/agents/me/secrets',root),{headers:{authorization:'Bearer '+api},redirect:'error'}); const listing=await list.json(); const a=await fetch(secret,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+api,'content-type':'application/json'},body:'{}'}); await a.body?.cancel(); const b=await fetch(broker,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+brokerAuth,'x-paperclip-github-capability':capability,'content-type':'application/json'},body:'{}'}); const j=await b.json(); console.log('PAPERCLIP_GIT_BOUNDARY '+JSON.stringify({runId:e.PAPERCLIP_RUN_ID,identityContextId:j.identityContextId,runSecretListAvailable:list.status===200&&Array.isArray(listing.secrets),githubSecretNotBound:Array.isArray(listing.secrets)&&!listing.secrets.some(s=>s.key==='GITHUB_TOKEN'),secretStatus:a.status,brokerStatus:b.status,brokerAbsent:j.status==='absent',brokerAvailable:j.status==='available',brokerConnectionId:j.connectionId||null,brokerGrantId:j.grantId||null,brokerEnvEmpty:Object.keys(j.env||{}).length===0,rawGitCredentialPresent:['GH_TOKEN','GITHUB_TOKEN','PAPERCLIP_GIT_TOKEN'].some(k=>!!e[k])}));`;
export const workloadBoundaryCommand = `node --input-type=module -e ${JSON.stringify(workloadBoundaryCode)}`;
export interface BoundaryReceipt { identityMatched?: boolean; runId: string; identityContextId: string; runSecretListAvailable: boolean; githubSecretNotBound: boolean; secretStatus: number; brokerStatus: number; brokerAbsent: boolean; brokerAvailable?: boolean; brokerConnectionId?: string | null; brokerGrantId?: string | null; brokerEnvEmpty: boolean; rawGitCredentialPresent: boolean }
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** A reply/file containing these words cannot qualify: require the actual
 * durable provider command item and its successful terminal result. */
export function workloadBoundaryReceipts(events: Array<{ eventType?: string; payload?: unknown }>): BoundaryReceipt[] {
  const receipts: BoundaryReceipt[] = [];
  for (const event of events) {
    const payload = record(record(event.payload).prpEvent), inner = record(payload.payload), item = record(inner.item);
    if (event.eventType !== "item.completed" || item.type !== "command_execution" || item.exit_code !== 0 || typeof item.command !== "string" || !item.command.includes(workloadBoundaryCode)) continue;
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    for (const line of output.split("\n")) if (line.startsWith("PAPERCLIP_GIT_BOUNDARY ")) {
      try { receipts.push(JSON.parse(line.slice("PAPERCLIP_GIT_BOUNDARY ".length)) as BoundaryReceipt); } catch { /* incomplete proof fails */ }
    }
  }
  return receipts;
}
export function protectedWorkload(receipts: BoundaryReceipt[], grant?: { connectionId: string; grantId: string; readonlyAppVerified: true; selectedRepositoryVerified: true }) {
  const managed = (r: BoundaryReceipt) => !!grant && grant.readonlyAppVerified && grant.selectedRepositoryVerified && r.brokerAvailable === true && r.brokerAbsent === false
    && r.brokerConnectionId === grant.connectionId && r.brokerGrantId === grant.grantId && r.brokerEnvEmpty === false;
  return receipts.length > 0 && receipts.every(r => r.identityMatched === true && !!r.runId && !!r.identityContextId && r.runSecretListAvailable && r.githubSecretNotBound && r.secretStatus === 403
    && r.brokerStatus === 200 && !r.rawGitCredentialPresent && (r.brokerAbsent && r.brokerEnvEmpty || managed(r)))
    && (!grant || receipts.some(managed));
}
export async function sourceProtectionReceipt(ctx: ChatCatalogContext) {
  const sources = ["server/src/services/execution-workspace-repositories.ts", "server/src/services/git-credentials.ts", "server/src/services/github-operation-credentials.ts", "packages/adapter-utils/src/github-launcher.ts"];
  await ctx.input.evidence("workspace-repository-acquisition-contract.json", { sources: await Promise.all(sources.map(async source => ({ source, sha256: digest(await readFile(new URL(`../../../${source}`, import.meta.url))) }))),
    acquisition: "catalog-authorized task/run server clone; no workload token grant", workload: "managed-only broker; actual own-run absent/empty response and secret403 required", simulatedCredentialBridge: false });
}
