import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function seedBranchRepair(base, { inheritAgentStrategy = false } = {}) {
  assert.equal(new URL(base).hostname, "127.0.0.1", "Use a disposable loopback instance");
  const api = async (route, method = "GET", body) => {
    const response = await fetch(`${base}/api${route}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, `${response.status}: ${await response.clone().text()}`);
    return response.json();
  };
  assert.equal((await api("/health")).deploymentMode, "local_trusted");
  await api("/instance/settings/experimental", "PATCH", { enableIsolatedWorkspaces: true, enableClassicTaskInterface: false });
  const company = await api("/companies", "POST", { name: "Branch Repair Acceptance" });
  const root = await mkdtemp(path.join(os.tmpdir(), "branch-repair-"));
  const source = path.join(root, "source"), remote = path.join(root, "origin.git"), checkout = path.join(root, "checkout");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-b", "master", source);
  await writeFile(path.join(source, "README.md"), "Branch repair acceptance fixture\n");
  git("-C", source, "add", ".");
  git("-C", source, "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.test", "commit", "-m", "fixture");
  git("clone", "--bare", source, remote);
  git("clone", remote, checkout);
  const project = await api(`/companies/${company.id}/projects`, "POST", { name: "Master-only repository", status: "in_progress",
    workspace: { name: "Repository", cwd: checkout, repoUrl: pathToFileURL(remote).href, isPrimary: true },
    executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", allowIssueOverride: true, ...(inheritAgentStrategy ? {} : { workspaceStrategy: { type: "git_worktree" } }) },
  });
  const agent = await api(`/companies/${company.id}/agents`, "POST", { name: "Branch verification worker", role: "engineer", adapterType: "process",
    adapterConfig: { command: process.execPath, args: [path.resolve(import.meta.dirname, "worker.mjs"), ...(inheritAgentStrategy ? ["--expect-setup"] : [])],
      ...(inheritAgentStrategy ? { workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "agent/{{issue.identifier}}", worktreeParentDir: ".agent-worktrees", provisionCommand: `node -e "require('node:fs').writeFileSync('setup-proof.txt', 'ready')"` } } : {}) },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
  });
  const issue = await api(`/companies/${company.id}/issues`, "POST", { title: "Repair the missing starting branch", status: "todo", projectId: project.id, assigneeAgentId: agent.id,
    executionWorkspacePreference: "isolated_workspace", executionWorkspaceSettings: { mode: "isolated_workspace", ...(inheritAgentStrategy ? {} : { workspaceStrategy: { type: "git_worktree", baseRef: "main" } }) },
  });
  return { base, companyId: company.id, issueId: issue.id, identifier: issue.identifier, prefix: company.issuePrefix, agentId: agent.id, projectId: project.id, root, checkout };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await seedBranchRepair(process.argv[2], { inheritAgentStrategy: process.argv.includes("--agent-defaults") })));
