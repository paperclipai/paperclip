import type { Db } from "@paperclipai/db";
import { resolveGitHubApiCredential, type GitHubApiCredential } from "./git-credentials.js";
import type { GitHubPullRequestReference } from "./github-pull-request-merge.js";

export type GitHubWorkspaceDeliveryInput = {
  companyId: string;
  repoUrl: string | null;
  headSha: string | null;
  destinationRef: string | null;
  pullRequests?: GitHubPullRequestReference[];
};
export type GitHubWorkspaceDeliveryResult =
  | {
      status: "delivered";
      headSha: string;
      destinationRef: string;
      destinationTipSha: string;
      evidence: { kind: "ancestry" } | { kind: "merged_pr"; number: number; mergeCommitSha: string };
    }
  | { status: "not_delivered" }
  | { status: "unknown"; reason: string };
export type GitHubWorkspaceDeliveryResolver = (input: GitHubWorkspaceDeliveryInput) => Promise<GitHubWorkspaceDeliveryResult>;

type Options = {
  fetch?: typeof fetch;
  credentialProvider?: (companyId: string) => Promise<GitHubApiCredential | null>;
};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const sha = (value: unknown): string | null => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
const unknown = (reason: string): GitHubWorkspaceDeliveryResult => ({ status: "unknown", reason });

class Unavailable extends Error {}

export function createGitHubWorkspaceDeliveryResolver(db: Db, opts: Options = {}): GitHubWorkspaceDeliveryResolver {
  const fetchImpl = opts.fetch ?? fetch;
  const credentialProvider = opts.credentialProvider ?? ((companyId: string) => resolveGitHubApiCredential(db, companyId));
  return async (input) => {
    const repository = /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(input.repoUrl?.trim() ?? "");
    const headSha = sha(input.headSha);
    let ref = input.destinationRef?.trim();
    if (!repository || !headSha || !ref || ref === "HEAD") return unknown("unsupported_source_or_destination");
    if (ref.startsWith("refs/remotes/origin/")) ref = `refs/heads/${ref.slice(20)}`;
    else if (ref.startsWith("origin/")) ref = `refs/heads/${ref.slice(7)}`;
    if (ref.startsWith("refs/") && !ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/")) return unknown("unsupported_destination_ref");
    if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock") || ref.split("/").some((part) => !part || part.startsWith("."))) return unknown("unsupported_destination_ref");
    const owner = repository[1]!.toLowerCase();
    const repo = repository[2]!.toLowerCase();
    const fullName = `${owner}/${repo}`;
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    try {
      const credential = await credentialProvider(input.companyId);
      const signal = AbortSignal.timeout(20_000);
      let requests = 0;
      async function read(path: string, allowMissing = false): Promise<{ body: unknown; next: boolean } | null> {
        if (++requests > 24) throw new Unavailable("request_budget_exhausted");
        const response = await fetchImpl(`https://api.github.com${prefix}${path}`, {
          redirect: "error", signal,
          headers: {
            accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
            ...(credential?.token ? { authorization: `Bearer ${credential.token}` } : {}),
          },
        });
        if (response.status === 404 && allowMissing) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new Unavailable(`github_http_${response.status}`); }
        const reader = response.body?.getReader();
        if (!reader) throw new Unavailable("invalid_response");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 2 * 1024 * 1024) throw new Unavailable("response_too_large");
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")), next: /rel="next"/.test(response.headers.get("link") ?? "") };
      }
      if (credential?.source === "server_env") {
        const repoData = record((await read(""))?.body);
        if (repoData?.private !== false || typeof repoData.full_name !== "string" || repoData.full_name.toLowerCase() !== fullName) return unknown("ambient_credential_requires_public_repository");
      }
      async function reference(kind: "heads" | "tags", name: string) {
        const result = await read(`/git/ref/${kind}/${encodeURIComponent(name)}`, true);
        if (!result) return null;
        const body = record(result.body);
        const object = record(body?.object);
        if (body?.ref !== `refs/${kind}/${name}` || !sha(object?.sha) || (object?.type !== "commit" && !(kind === "tags" && object?.type === "tag"))) throw new Unavailable("invalid_ref_response");
        if (object.type === "commit") return sha(object.sha)!;
        const commit = record((await read(`/commits/${encodeURIComponent(`tags/${name}`)}?per_page=1`))?.body);
        if (!sha(commit?.sha)) throw new Unavailable("invalid_commit_response");
        return sha(commit?.sha)!;
      }
      let destinationTipSha: string;
      let destinationRef: string;
      let branch: string | null = null;
      if (sha(ref)) {
        const commit = record((await read(`/commits/${ref}?per_page=1`))?.body);
        if (sha(commit?.sha) !== sha(ref)) return unknown("invalid_commit_response");
        destinationTipSha = sha(ref)!;
        destinationRef = destinationTipSha;
      } else if (ref.startsWith("refs/heads/")) {
        branch = ref.slice(11);
        const tip = await reference("heads", branch);
        if (!tip) return unknown("destination_missing_or_inaccessible");
        destinationTipSha = tip; destinationRef = ref;
      } else if (ref.startsWith("refs/tags/")) {
        const tip = await reference("tags", ref.slice(10));
        if (!tip) return unknown("destination_missing_or_inaccessible");
        destinationTipSha = tip; destinationRef = ref;
      } else {
        const branchTip = await reference("heads", ref);
        const tagTip = await reference("tags", ref);
        if (branchTip && tagTip) return unknown("ambiguous_destination_ref");
        if (!branchTip && !tagTip) return unknown("destination_missing_or_inaccessible");
        branch = branchTip ? ref : null;
        destinationTipSha = (branchTip ?? tagTip)!;
        destinationRef = `refs/${branchTip ? "heads" : "tags"}/${ref}`;
      }
      const delivered = (evidence: Extract<GitHubWorkspaceDeliveryResult, { status: "delivered" }>["evidence"]): GitHubWorkspaceDeliveryResult => ({ status: "delivered", headSha, destinationRef, destinationTipSha, evidence });
      async function ancestor(candidate: string): Promise<boolean | null> {
        if (candidate === destinationTipSha) return true;
        const response = await read(`/compare/${candidate}...${destinationTipSha}?per_page=1`, true);
        if (!response) return null;
        const comparison = record(response.body);
        const base = sha(record(comparison?.base_commit)?.sha);
        const mergeBase = sha(record(comparison?.merge_base_commit)?.sha);
        if (base !== candidate || !mergeBase) throw new Unavailable("invalid_comparison_response");
        if (comparison?.status === "ahead") {
          if (mergeBase !== candidate || comparison.behind_by !== 0 || typeof comparison.ahead_by !== "number" || comparison.ahead_by <= 0) throw new Unavailable("invalid_comparison_response");
          return true;
        }
        if (mergeBase !== candidate && typeof comparison?.behind_by === "number" && comparison.behind_by > 0
          && ((comparison.status === "behind" && comparison.ahead_by === 0)
            || (comparison.status === "diverged" && typeof comparison.ahead_by === "number" && comparison.ahead_by > 0))) return false;
        throw new Unavailable("invalid_comparison_response");
      }
      const direct = await ancestor(headSha);
      if (direct === true) return delivered({ kind: "ancestry" });
      if (!branch) return direct === false ? { status: "not_delivered" } : unknown("comparison_unavailable");
      const checked = new Set<number>();
      let incomplete = direct === null;
      async function checkPull(number: number): Promise<GitHubWorkspaceDeliveryResult | null> {
        if (checked.has(number)) return null;
        checked.add(number);
        const result = await read(`/pulls/${number}`, true);
        if (!result) { incomplete = true; return null; }
        const pull = record(result.body);
        const base = record(pull?.base);
        const baseRepo = record(base?.repo);
        const pullHead = record(pull?.head);
        if (pull?.number !== number || typeof pull.merged !== "boolean" || !sha(pullHead?.sha) || typeof base?.ref !== "string" || typeof baseRepo?.full_name !== "string") throw new Unavailable("invalid_pull_response");
        if (!pull.merged || sha(pullHead?.sha) !== headSha || base.ref !== branch || baseRepo.full_name.toLowerCase() !== fullName) return null;
        const mergeCommitSha = sha(pull.merge_commit_sha);
        if (!mergeCommitSha) throw new Unavailable("invalid_merge_commit");
        const reachable = await ancestor(mergeCommitSha);
        if (reachable === null) incomplete = true;
        return reachable ? delivered({ kind: "merged_pr", number, mergeCommitSha }) : null;
      }
      for (const hint of input.pullRequests ?? []) {
        if (hint.host !== "github.com" || hint.owner.toLowerCase() !== owner || hint.repo.toLowerCase() !== repo || !Number.isSafeInteger(hint.number) || hint.number < 1) continue;
        const proof = await checkPull(hint.number);
        if (proof) return proof;
      }
      for (let page = 1; page <= 3; page++) {
        const response = await read(`/commits/${headSha}/pulls?per_page=100&page=${page}`);
        if (!Array.isArray(response?.body)) throw new Unavailable("invalid_association_response");
        for (const value of response.body) {
          const number = record(value)?.number;
          if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Unavailable("invalid_association_response");
          const proof = await checkPull(number);
          if (proof) return proof;
        }
        if (!response.next) return incomplete ? unknown("comparison_unavailable") : { status: "not_delivered" };
      }
      return unknown("association_budget_exhausted");
    } catch (error) {
      return unknown(error instanceof Unavailable ? error.message : "github_unavailable");
    }
  };
}
