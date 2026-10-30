import { test, expect } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const base = process.env.INSTRUCTION_COPY_TEST_URL;
test.skip(!base, "Launch this suite's disposable instruction-capable test-drive; see README.md");

test("saves stopped-process edits, shows completed tasks, and restores saved bytes on the next task", async ({ page }, info) => {
  expect(new URL(base!).hostname).toBe("127.0.0.1");
  const api = async (route: string, method = "GET", body?: unknown) => {
    const response = await page.request.fetch(`${base}/api${route}`, { method, data: body });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  expect((await api("/health")).deploymentMode).toBe("local_trusted");
  const [company] = await api("/companies");
  expect(company.name).toBe("Instruction Lifecycle QA");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "instruction-acceptance-"));
  try {
    const agent = await api(`/companies/${company.id}/agents`, "POST", {
      name: `Instruction worker ${path.basename(cwd)}`, role: "engineer", adapterType: "process",
      adapterConfig: { command: process.execPath, args: [path.resolve(import.meta.dirname, "worker.mjs")], cwd },
      instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": "# Original\n" } },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    });
    for (const turn of [0, 1]) {
      const issue = await api(`/companies/${company.id}/issues`, "POST", { title: `Persist instructions turn ${turn}`, status: "todo", assigneeAgentId: agent.id });
      await page.goto(`${base}/${company.issuePrefix}/issues/${issue.identifier}`);
      const runs = async () => (await api(`/companies/${company.id}/heartbeat-runs`)).filter((run: { contextSnapshot: { issueId?: string } }) => run.contextSnapshot?.issueId === issue.id);
      await expect.poll(async () => (await runs()).some((run: { status: string }) => run.status === "succeeded"), { timeout: 45_000 }).toBe(true);
      const history = await runs();
      expect(history).toHaveLength(1);
      const run = await api(`/heartbeat-runs/${history[0].id}`);
      expect(run.resultJson.instructionSave).toMatchObject({ state: turn === 0 ? "saved" : "unchanged", contract: "agent_files", entryFile: "AGENTS.md" });
      const outputLine = run.stdoutExcerpt.split("\n").find((line: string) => line.startsWith('{"before":'));
      expect(outputLine).toBeTruthy();
      const output = JSON.parse(outputLine!);
      expect(output.before).toBe(turn === 0 ? "# Original\n" : "# Saved by the real worker\n☃\n");
      expect((await api(`/agents/${agent.id}/instructions-bundle/file?path=AGENTS.md`)).content).toBe("# Saved by the real worker\n☃\n");
      await expect.poll(async () => stat(output.instructionPath).then(() => true, () => false)).toBe(false);
      await page.reload();
      await expect(page.getByRole("button", { name: /^Change status \(current: Done/ }).first()).toBeVisible();
      await page.screenshot({ path: info.outputPath(`completed-turn-${turn}.png`), fullPage: true });
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
