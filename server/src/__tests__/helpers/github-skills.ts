import { createHash } from "node:crypto";
import type { GitHubRead } from "../../services/github-skill-source.js";
export function githubFixture(files: Record<string, string | Buffer>, modes: Record<string, string> = {}, commit = "a".repeat(40)): GitHubRead {
  const entries = Object.keys(files).map((path, i) => ({ path, type: modes[path] === '160000' ? 'commit' : 'blob', mode: modes[path] ?? '100644', sha: String(i), size: Buffer.byteLength(files[path]!) }));
  const treeSha = createHash("sha1").update(JSON.stringify(entries.map(entry => [entry.path, entry.mode, files[entry.path]]).sort())).digest("hex");
  const read = (async (url: string) => {
    if (url === '/repos/acme/skills') return { id: 42, full_name: 'acme/skills', default_branch: 'main' };
    if (url.startsWith('/repos/acme/skills/commits/')) return { sha: commit, commit: { tree: { sha: treeSha } } };
    throw new Error(`Unexpected request ${url}`);
  }) as GitHubRead;
  read.openSnapshot = async (_input, options) => {
    options?.signal?.throwIfAborted();
    await options?.onDownload?.({ stage: 'receiving', percent: 50, receivedBytes: 1024 });
    return { commitSha: commit, treeSha, downloadBytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0), entries, readBlob: async entry => Buffer.from(files[entry.path]!), release: async () => {} };
  };
  return read;
}
