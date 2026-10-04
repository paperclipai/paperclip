import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

export async function seedWorkspaceBootstrap(base, persistent = false) {
  const url = new URL(base);
  assert.equal(url.hostname, "127.0.0.1", "Fixture must target a disposable loopback test-drive");
  const api = async (route, method = "GET", body) => {
    const response = await fetch(`${base}/api${route}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, `${response.status}: ${await response.clone().text()}`);
    return response.json();
  };
  const health = await api("/health");
  assert.equal(health.deploymentMode, "local_trusted");
  const [company] = await api("/companies");
  assert.equal(company.name, "Workspace Recovery QA");
  const source = await mkdtemp(path.join(os.tmpdir(), "workspace-bootstrap-source-"));
  const git = (...args) => execFileSync(process.env.BOOTSTRAP_REAL_GIT || "/usr/bin/git", args, { cwd: source, stdio: "ignore" });
  git("init", "-b", "main");
  await writeFile(path.join(source, "README.md"), "Committed work\n");
  await writeFile(path.join(source, ".gitignore"), "private.secret\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
  await writeFile(path.join(source, "README.md"), "Existing uncommitted work\n");
  await writeFile(path.join(source, "private.secret"), "test-only secret\n");
  await writeFile(path.join(source, ".git", persistent ? "bootstrap-fail-always" : "bootstrap-fail-once"), "armed\n");
  const suffix = path.basename(source).slice(-6);
  const project = await api(`/companies/${company.id}/projects`, "POST", { name: `${persistent ? "Persistent scan failure" : "Recoverable repository"} ${suffix}`, status: "in_progress", workspace: { name: "Anchor", cwd: source, isPrimary: true } });
  await api(`/projects/${project.id}/workspaces`, "POST", { name: "Source copy", cwd: source, repoUrl: pathToFileURL(source).href, isPrimary: false });
  const agent = await api(`/companies/${company.id}/agents`, "POST", {
    name: `${persistent ? "Persistent failure worker" : "Recovery worker"} ${suffix}`, role: "engineer", adapterType: "process",
    adapterConfig: { command: process.execPath, args: [path.resolve(import.meta.dirname, "worker.mjs")], cwd: source },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
  });
  return { base, companyId: company.id, prefix: company.issuePrefix, projectId: project.id, agentId: agent.id, agentName: agent.name, projectName: project.name, source };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await seedWorkspaceBootstrap(process.argv[2], process.argv.includes("--persistent"))));
}
