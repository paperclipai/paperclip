import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const HERMES_MODEL = process.env.PAPERCLIP_E2E_HERMES_MODEL ?? "gpt-4o";
const EXECUTING_PLANS_ANNOUNCEMENT = "I'm using the executing-plans skill to implement this plan.";
const execFileAsync = promisify(execFile);

function resolveHermesHomeCandidatesForTests() {
  return Array.from(
    new Set(
      [
        process.env.HERMES_HOME,
        process.env.PAPERCLIP_E2E_HERMES_HOME,
        process.env.PAPERCLIP_E2E_HOME
          ? path.join(process.env.PAPERCLIP_E2E_HOME, "hermes")
          : null,
        process.env.PAPERCLIP_E2E_HOME,
        path.join(os.homedir(), ".hermes"),
      ]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => path.resolve(value)),
    ),
  );
}

function resolveActiveHermesHomeForTests() {
  const explicit = process.env.PAPERCLIP_E2E_HERMES_HOME;
  if (explicit) return path.resolve(explicit);
  if (process.env.PAPERCLIP_E2E_HOME) {
    return path.resolve(path.join(process.env.PAPERCLIP_E2E_HOME, "hermes"));
  }
  if (process.env.HERMES_HOME) return path.resolve(process.env.HERMES_HOME);
  return path.join(os.homedir(), ".hermes");
}

async function findFirstExistingPath(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await fs.stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function copyOptionalFile(sourcePath: string, targetPath: string) {
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  } catch {
    // ignore missing optional source files
  }
}

async function ensureHermesHomeSeeded(targetHome: string) {
  const sourceHome = path.join(os.homedir(), ".hermes");
  const resolvedTarget = path.resolve(targetHome);
  if (resolvedTarget === path.resolve(sourceHome)) return;

  await fs.mkdir(resolvedTarget, { recursive: true });
  await copyOptionalFile(path.join(sourceHome, "config.yaml"), path.join(resolvedTarget, "config.yaml"));
  await copyOptionalFile(path.join(sourceHome, ".env"), path.join(resolvedTarget, ".env"));
  await copyOptionalFile(path.join(sourceHome, "auth.json"), path.join(resolvedTarget, "auth.json"));
  await copyOptionalFile(path.join(sourceHome, "oauth.json"), path.join(resolvedTarget, "oauth.json"));
  await copyOptionalFile(path.join(sourceHome, "active_profile"), path.join(resolvedTarget, "active_profile"));

  try {
    await fs.stat(path.join(resolvedTarget, "profiles"));
  } catch {
    try {
      await fs.cp(path.join(sourceHome, "profiles"), path.join(resolvedTarget, "profiles"), {
        recursive: true,
      });
    } catch {
      // ignore missing profiles
    }
  }
}

async function execHermes(home: string, args: string[]) {
  const env = { ...process.env, HERMES_HOME: home };
  return await execFileAsync("hermes", args, {
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function findSkillDirsByName(rootDir: string, skillName: string) {
  const skillsRoot = path.join(rootDir, "skills");
  const matches: string[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const skillFile = path.join(entryPath, "SKILL.md");
        if (entry.name === skillName) {
          try {
            await fs.stat(skillFile);
            matches.push(entryPath);
            continue;
          } catch {
            // keep walking nested directories
          }
        }
        await walk(entryPath);
      }
    }
  }

  await walk(skillsRoot);
  return matches;
}

async function installHermesSkillInHomes(skillIdentifier: string, skillName: string) {
  const installedDirs = new Set<string>();
  const errors: string[] = [];

  for (const hermesHome of resolveHermesHomeCandidatesForTests()) {
    await ensureHermesHomeSeeded(hermesHome);
    try {
      await execHermes(hermesHome, ["skills", "install", skillIdentifier, "--yes"]);
      const matches = await findSkillDirsByName(hermesHome, skillName);
      for (const match of matches) installedDirs.add(match);
    } catch (error) {
      errors.push(`${hermesHome}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (installedDirs.size === 0) {
    throw new Error(
      `Failed to install Hermes skill ${skillIdentifier} in any candidate home.\n${errors.join("\n")}`,
    );
  }

  return Array.from(installedDirs);
}

async function createHermesCompanyAndCeo(
  page: Page,
  input: {
    companyName: string;
    ceoTaskTitle: string;
    ceoTaskBody: string;
  },
) {
  await page.goto("/");

  const wizardHeading = page.locator("h3", { hasText: "Name your company" });
  const newCompanyButton = page.getByRole("button", { name: "New Company" });
  const addCompanyButton = page.getByRole("button", { name: "Add company" });

  const isVisible = async (locator: ReturnType<Page["locator"]>) => {
    try {
      return await locator.isVisible();
    } catch {
      return false;
    }
  };

  if (
    !(await isVisible(wizardHeading)) &&
    !(await isVisible(newCompanyButton)) &&
    !(await isVisible(addCompanyButton))
  ) {
    await page.goto("/companies");
  }

  await expect
    .poll(
      async () =>
        (await isVisible(wizardHeading)) ||
        (await isVisible(newCompanyButton)) ||
        (await isVisible(addCompanyButton)),
      { timeout: 15_000 },
    )
    .toBe(true);

  if (!(await isVisible(wizardHeading))) {
    const createCompanyButton =
      (await isVisible(newCompanyButton)) ? newCompanyButton : addCompanyButton;
    await expect(createCompanyButton).toBeVisible({ timeout: 15_000 });
    await createCompanyButton.click();
  }

  await page.locator('input[placeholder="Acme Corp"]').fill(input.companyName);
  await page.getByRole("button", { name: "Next" }).click();

  await expect(
    page.locator("h3", { hasText: "Create your first agent" }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "More Agent Adapter Types" }).click();
  await page.getByRole("button", { name: "Hermes Agent" }).click();

  const modelField = page.locator("label", { hasText: "Model" }).locator("..");
  const modelTrigger = modelField.getByRole("button").first();
  await modelTrigger.click();

  const modelOption = page
    .locator("[data-radix-popper-content-wrapper] button")
    .filter({ hasText: HERMES_MODEL })
    .first();
  await expect(modelOption).toBeVisible({ timeout: 20_000 });
  await modelOption.click();
  await expect(modelTrigger).toContainText(HERMES_MODEL);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(
    page.locator("h3", { hasText: "Give it something to do" }),
  ).toBeVisible({ timeout: 10_000 });

  await page
    .locator('input[placeholder="e.g. Research competitor pricing"]')
    .fill(input.ceoTaskTitle);
  await page.locator("textarea").fill(input.ceoTaskBody);
  await page.getByRole("button", { name: "Next" }).click();

  await expect(
    page.locator("h3", { hasText: "Ready to launch" }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Create & Open Issue" }).click();
  await expect(page).toHaveURL(/\/issues\//, { timeout: 20_000 });

  const baseUrl = page.url().split("/").slice(0, 3).join("/");

  const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
  expect(companiesRes.ok()).toBe(true);
  const companies = await companiesRes.json();
  const company = companies.find((entry: { name: string }) => entry.name === input.companyName);
  expect(company).toBeTruthy();

  if (!company.requireBoardApprovalForNewAgents) {
    const updateRes = await page.request.patch(`${baseUrl}/api/companies/${company.id}`, {
      data: { requireBoardApprovalForNewAgents: true },
    });
    expect(updateRes.ok()).toBe(true);
  }

  const agentsRes = await page.request.get(`${baseUrl}/api/companies/${company.id}/agents`);
  expect(agentsRes.ok()).toBe(true);
  const agents = await agentsRes.json();
  const ceoAgent = agents.find((entry: { name: string }) => entry.name === "CEO");
  expect(ceoAgent).toBeTruthy();
  expect(ceoAgent.adapterType).toBe("hermes_local");
  expect(ceoAgent.adapterConfig.model).toBe(HERMES_MODEL);

  return { baseUrl, company, ceoAgent };
}

async function waitForHireApproval(
  request: APIRequestContext,
  input: {
    baseUrl: string;
    companyId: string;
    requestedByAgentId: string;
    workerName: string;
  },
) {
  let approvalId = "";
  await expect
    .poll(
      async () => {
        const approvalsRes = await request.get(
          `${input.baseUrl}/api/companies/${input.companyId}/approvals?status=pending`,
        );
        if (!approvalsRes.ok()) return "";
        const approvals = await approvalsRes.json();
        const hireApproval = approvals.find(
          (entry: {
            id: string;
            type: string;
            requestedByAgentId: string | null;
            payload?: { name?: string; adapterType?: string };
          }) =>
            entry.type === "hire_agent" &&
            entry.requestedByAgentId === input.requestedByAgentId &&
            entry.payload?.name === input.workerName &&
            entry.payload?.adapterType === "hermes_local",
        );
        approvalId = hireApproval?.id ?? "";
        return approvalId;
      },
      {
        timeout: 4 * 60 * 1000,
        intervals: [5_000, 10_000],
      },
    )
    .not.toBe("");

  return approvalId;
}

async function approveApprovalViaUi(
  page: Page,
  input: { baseUrl: string; issuePrefix: string; approvalId: string },
) {
  await page.goto(`${input.baseUrl}/${input.issuePrefix}/approvals/${input.approvalId}`);
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approval confirmed")).toBeVisible({ timeout: 20_000 });
}

async function waitForAgentByName(
  request: APIRequestContext,
  input: { baseUrl: string; companyId: string; agentName: string },
) {
  let agentId = "";
  await expect
    .poll(
      async () => {
        const agentsRes = await request.get(
          `${input.baseUrl}/api/companies/${input.companyId}/agents`,
        );
        if (!agentsRes.ok()) return "";
        const agents = await agentsRes.json();
        const match = agents.find(
          (entry: { id: string; name: string; status: string; adapterType: string }) =>
            entry.name === input.agentName &&
            entry.adapterType === "hermes_local" &&
            entry.status !== "pending_approval" &&
            entry.status !== "terminated",
        );
        agentId = match?.id ?? "";
        return agentId;
      },
      {
        timeout: 2 * 60 * 1000,
        intervals: [2_000, 5_000],
      },
    )
    .not.toBe("");

  return agentId;
}

async function waitForIssueByTitle(
  request: APIRequestContext,
  input: { baseUrl: string; companyId: string; title: string },
) {
  let issue: Record<string, unknown> | null = null;
  await expect
    .poll(
      async () => {
        const issuesRes = await request.get(`${input.baseUrl}/api/companies/${input.companyId}/issues`);
        if (!issuesRes.ok()) return false;
        const issues = await issuesRes.json();
        issue = issues.find((entry: { title: string }) => entry.title === input.title) ?? null;
        return Boolean(issue);
      },
      {
        timeout: 4 * 60 * 1000,
        intervals: [5_000, 10_000],
      },
    )
    .toBe(true);

  expect(issue).toBeTruthy();
  return issue!;
}

async function waitForIssueStatus(
  request: APIRequestContext,
  input: { baseUrl: string; issueId: string; status: string },
) {
  await expect
    .poll(
      async () => {
        const issueRes = await request.get(`${input.baseUrl}/api/issues/${input.issueId}`);
        if (!issueRes.ok()) return "";
        const issue = await issueRes.json();
        return issue.status;
      },
      {
        timeout: 6 * 60 * 1000,
        intervals: [5_000, 10_000],
      },
    )
    .toBe(input.status);
}

async function waitForIssueComment(
  request: APIRequestContext,
  input: { baseUrl: string; issueId: string; contains: string },
) {
  await expect
    .poll(
      async () => {
        const commentsRes = await request.get(`${input.baseUrl}/api/issues/${input.issueId}/comments`);
        if (!commentsRes.ok()) return false;
        const comments = await commentsRes.json();
        return comments.some(
          (comment: { body?: string | null }) =>
            typeof comment.body === "string" && comment.body.includes(input.contains),
        );
      },
      {
        timeout: 6 * 60 * 1000,
        intervals: [5_000, 10_000],
      },
    )
    .toBe(true);
}

async function waitForIssueCommentMatch(
  request: APIRequestContext,
  input: { baseUrl: string; issueId: string; pattern: RegExp },
) {
  let matchedBody = "";
  await expect
    .poll(
      async () => {
        const commentsRes = await request.get(`${input.baseUrl}/api/issues/${input.issueId}/comments`);
        if (!commentsRes.ok()) return "";
        const comments = await commentsRes.json();
        const match = comments.find(
          (comment: { body?: string | null }) =>
            typeof comment.body === "string" && input.pattern.test(comment.body),
        );
        matchedBody = typeof match?.body === "string" ? match.body : "";
        return matchedBody;
      },
      {
        timeout: 6 * 60 * 1000,
        intervals: [5_000, 10_000],
      },
    )
    .not.toBe("");

  return matchedBody;
}

async function waitForIssueCommentRecord(
  request: APIRequestContext,
  input: {
    baseUrl: string;
    issueId: string;
    exact?: string;
    contains?: string;
    pattern?: RegExp;
  },
) {
  let matchedComment: {
    id: string;
    body?: string | null;
    authorAgentId?: string | null;
    createdByRunId?: string | null;
  } | null = null;

  await expect
    .poll(
      async () => {
        const commentsRes = await request.get(`${input.baseUrl}/api/issues/${input.issueId}/comments`);
        if (!commentsRes.ok()) return "";
        const comments = await commentsRes.json();
        matchedComment =
          comments.find((comment: { id: string; body?: string | null }) => {
            if (typeof comment.body !== "string") return false;
            if (typeof input.exact === "string") return comment.body.trim() === input.exact;
            if (typeof input.contains === "string") return comment.body.includes(input.contains);
            if (input.pattern) return input.pattern.test(comment.body);
            return false;
          }) ?? null;
        return matchedComment?.id ?? "";
      },
      {
        timeout: 6 * 60 * 1000,
        intervals: [5_000, 10_000],
      },
    )
    .not.toBe("");

  expect(matchedComment).toBeTruthy();
  return matchedComment!;
}

async function createNativeHermesSkill(
  skillName: string,
  activationPhrase: string,
) {
  const skillDirs: string[] = [];
  for (const hermesHome of resolveHermesHomeCandidatesForTests()) {
    const skillDir = path.join(hermesHome, "skills", "native", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        `name: ${skillName}`,
        "description: Use when asked to run the Paperclip native skill smoke test.",
        "---",
        "",
        "# Native Skill Smoke Test",
        "",
        "When this skill is loaded, treat the next Paperclip issue comment as a proof-of-use checkpoint.",
        `Include the exact activation phrase "${activationPhrase}" in that comment before finishing the task.`,
        "",
      ].join("\n"),
      "utf8",
    );
    skillDirs.push(skillDir);
  }
  return skillDirs;
}

async function findHermesHomeWithCronJob(jobId: string) {
  for (const hermesHome of resolveHermesHomeCandidatesForTests()) {
    try {
      const { stdout } = await execHermes(hermesHome, ["cron", "list", "--all"]);
      if (stdout.includes(jobId)) {
        return hermesHome;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function waitForCronArtifact(home: string, jobId: string) {
  let artifactPath = "";
  await expect
    .poll(
      async () => {
        const outputDir = path.join(home, "cron", "output", jobId);
        const entries = await fs.readdir(outputDir).catch(() => []);
        if (entries.length === 0) return "";
        const artifacts = await Promise.all(
          entries.map(async (entry) => {
            const absolutePath = path.join(outputDir, entry);
            const stat = await fs.stat(absolutePath).catch(() => null);
            return stat?.isFile() ? { absolutePath, mtimeMs: stat.mtimeMs } : null;
          }),
        );
        const latest = artifacts
          .filter((entry): entry is { absolutePath: string; mtimeMs: number } => Boolean(entry))
          .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
        artifactPath = latest?.absolutePath ?? "";
        return artifactPath;
      },
      {
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .not.toBe("");

  return artifactPath;
}

function resolvePaperclipE2EHomeForTests() {
  const candidate = process.env.PAPERCLIP_E2E_HOME;
  if (!candidate) {
    throw new Error("PAPERCLIP_E2E_HOME must be set for Hermes hierarchy E2E tests.");
  }
  return path.resolve(candidate);
}

async function waitForRunLogOutput(input: {
  companyId: string;
  agentId: string;
  runId: string;
}) {
  const logPath = path.join(
    resolvePaperclipE2EHomeForTests(),
    "instances",
    "default",
    "data",
    "run-logs",
    input.companyId,
    input.agentId,
    `${input.runId}.ndjson`,
  );

  let combinedOutput = "";
  await expect
    .poll(
      async () => {
        const text = await fs.readFile(logPath, "utf8").catch(() => "");
        if (!text.trim()) {
          combinedOutput = "";
          return "";
        }
        combinedOutput = text
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              const record = JSON.parse(line) as { chunk?: string | null };
              return typeof record.chunk === "string" ? record.chunk : "";
            } catch {
              return "";
            }
          })
          .join("");
        return combinedOutput;
      },
      {
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .not.toBe("");

  return combinedOutput;
}

test.describe("Hermes hierarchy and skill flows", () => {
  test.setTimeout(18 * 60 * 1000);

  test("supports Paperclip-managed skills, native Hermes skills, and manager-worker delegation", async ({
    page,
  }) => {
    const suffix = Date.now();
    const companyName = `Hermes Hierarchy ${suffix}`;
    const managerName = `HermesManager${suffix}`;
    const workerName = `HermesWorker${suffix}`;
    const managerIssueTitle = `Manager delegation ${suffix}`;
    const workerIssueTitle = `Worker native skill ${suffix}`;
    const importedSkillName = "verification-before-completion";
    const importedSkillProof = "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE";
    const importedSkillToken = `SUPERPOWERS_SKILL_OK_${suffix}`;
    const nativeSkillName = `paperclip-native-proof-${suffix}`;
    const nativeSkillPhrase = `NATIVE_DIRECT_REPORT_PROTOCOL_${suffix}`;
    const nativeSkillToken = `NATIVE_SKILL_OK_${suffix}`;
    const authoredSkillName = `paperclip-authored-proof-${suffix}`;
    const authoredSkillPhrase = `AUTHORED_NATIVE_PROTOCOL_${suffix}`;
    const authoredSkillToken = `AUTHORED_NATIVE_SKILL_OK_${suffix}`;
    const authoredIssueTitle = `Worker authored native skill ${suffix}`;
    const authoredSkillTargetPath = path.join(
      resolveActiveHermesHomeForTests(),
      "skills",
      "native",
      authoredSkillName,
      "SKILL.md",
    );
    const installedSkillName = "executing-plans";
    const installedSkillIssueTitle = `Worker installed native skill ${suffix}`;
    const installedSkillToken = `INSTALLED_NATIVE_SKILL_OK_${suffix}`;
    const installedSkillProofToken = `INSTALLED_NATIVE_FILE_OK_${suffix}`;
    const installedSkillPlanPath = path.join(os.tmpdir(), `paperclip-executing-plan-${suffix}.md`);
    const installedSkillProofPath = path.join(os.tmpdir(), `paperclip-executing-proof-${suffix}.txt`);
    const cronIssueTitle = `Worker cron tool ${suffix}`;
    const cronResponseToken = `CRON_AGENT_RESPONSE_${suffix}`;
    const cronJobCommentPrefix = `CRON_JOB_ID_${suffix}::`;
    const delegateToken = `MANAGER_DELEGATED_${suffix}`;
    const authoredSkillDirs = resolveHermesHomeCandidatesForTests().map((home) =>
      path.join(home, "skills", "native", authoredSkillName),
    );
    await installHermesSkillInHomes(installedSkillName, installedSkillName);
    const nativeSkillDirs = await createNativeHermesSkill(nativeSkillName, nativeSkillPhrase);

    try {
      const { baseUrl, company, ceoAgent } = await createHermesCompanyAndCeo(page, {
        companyName,
        ceoTaskTitle: `Hire ${managerName}`,
        ceoTaskBody: [
          `Create exactly one subordinate agent named ${managerName}.`,
          "Requirements:",
          "- Use the Paperclip hire flow so the board can review the request.",
          "- adapterType must be hermes_local.",
          `- model should be ${HERMES_MODEL} when possible.`,
          "- role should be engineer.",
          "- reportsTo should be yourself.",
          "- Do not create extra agents or duplicate approvals.",
          "- After the hire request exists, wait for the board decision.",
        ].join("\n"),
      });

      const managerApprovalId = await waitForHireApproval(page.request, {
        baseUrl,
        companyId: company.id,
        requestedByAgentId: ceoAgent.id,
        workerName: managerName,
      });
      await approveApprovalViaUi(page, {
        baseUrl,
        issuePrefix: company.issuePrefix,
        approvalId: managerApprovalId,
      });

      const managerAgentId = await waitForAgentByName(page.request, {
        baseUrl,
        companyId: company.id,
        agentName: managerName,
      });

      const managerPermissionsRes = await page.request.patch(
        `${baseUrl}/api/agents/${managerAgentId}/permissions?companyId=${company.id}`,
        {
          data: { canCreateAgents: true, canAssignTasks: true },
        },
      );
      expect(managerPermissionsRes.ok()).toBe(true);

      const importRes = await page.request.post(
        `${baseUrl}/api/companies/${company.id}/skills/import`,
        {
          data: {
            source: `npx skills add https://github.com/obra/superpowers --skill ${importedSkillName}`,
          },
        },
      );
      expect(importRes.ok()).toBe(true);
      const imported = await importRes.json();
      const importedSkill = imported.imported.find(
        (entry: { slug: string }) => entry.slug === importedSkillName,
      );
      expect(importedSkill).toBeTruthy();

      const syncRes = await page.request.post(
        `${baseUrl}/api/agents/${managerAgentId}/skills/sync?companyId=${company.id}`,
        {
          data: { desiredSkills: [importedSkill.key] },
        },
      );
      expect(syncRes.ok()).toBe(true);
      const syncSnapshot = await syncRes.json();
      const syncedSkill = syncSnapshot.entries.find(
        (entry: { key: string }) => entry.key === importedSkill.key,
      );
      expect(syncedSkill).toBeTruthy();
      expect(syncedSkill.state).toBe("installed");
      expect(syncedSkill.runtimeName).toBe(importedSkillName);

      const managerIssueRes = await page.request.post(
        `${baseUrl}/api/companies/${company.id}/issues`,
        {
          data: {
            title: managerIssueTitle,
            description: [
              `Load the Paperclip-managed skill named ${importedSkillName}.`,
              `After reading it, comment on this issue with exactly "${importedSkillToken} :: ${importedSkillProof}".`,
              `Then create exactly one subordinate agent named ${workerName} using /agent-hires.`,
              "- adapterType must be hermes_local.",
              `- model should be ${HERMES_MODEL} when possible.`,
              "- role should be engineer.",
              "- reportsTo should be yourself.",
              "- Do not create extra agents or duplicate approvals.",
              "- Wait for the board decision after submitting the hire request.",
              `After the worker exists, create exactly one new issue assigned to that worker titled "${workerIssueTitle}".`,
              `The worker issue must instruct the worker to load the native Hermes skill "${nativeSkillName}" and then comment with exactly "${nativeSkillToken} :: ${nativeSkillPhrase}" before marking the worker issue done.`,
              `After creating the worker issue, comment on this issue with exactly "${delegateToken}".`,
              "- Wait for the worker issue to finish, then mark this manager issue done.",
            ].join("\n"),
            assigneeAgentId: managerAgentId,
            status: "todo",
          },
        },
      );
      expect(managerIssueRes.ok()).toBe(true);
      const managerIssue = await managerIssueRes.json();

      await waitForIssueComment(page.request, {
        baseUrl,
        issueId: managerIssue.id,
        contains: `${importedSkillToken} :: ${importedSkillProof}`,
      });

      const workerApprovalId = await waitForHireApproval(page.request, {
        baseUrl,
        companyId: company.id,
        requestedByAgentId: managerAgentId,
        workerName,
      });
      await approveApprovalViaUi(page, {
        baseUrl,
        issuePrefix: company.issuePrefix,
        approvalId: workerApprovalId,
      });

      const workerAgentId = await waitForAgentByName(page.request, {
        baseUrl,
        companyId: company.id,
        agentName: workerName,
      });

      const managerAgentRes = await page.request.get(`${baseUrl}/api/agents/${managerAgentId}`);
      expect(managerAgentRes.ok()).toBe(true);
      const managerAgent = await managerAgentRes.json();
      expect(managerAgent.reportsTo).toBe(ceoAgent.id);

      const workerAgentRes = await page.request.get(`${baseUrl}/api/agents/${workerAgentId}`);
      expect(workerAgentRes.ok()).toBe(true);
      const workerAgent = await workerAgentRes.json();
      expect(workerAgent.reportsTo).toBe(managerAgentId);

      await waitForIssueComment(page.request, {
        baseUrl,
        issueId: managerIssue.id,
        contains: delegateToken,
      });

      const workerIssue = await waitForIssueByTitle(page.request, {
        baseUrl,
        companyId: company.id,
        title: workerIssueTitle,
      });
      expect(workerIssue.assigneeAgentId).toBe(workerAgentId);

      await waitForIssueComment(page.request, {
        baseUrl,
        issueId: workerIssue.id as string,
        contains: `${nativeSkillToken} :: ${nativeSkillPhrase}`,
      });
      await waitForIssueStatus(page.request, {
        baseUrl,
        issueId: workerIssue.id as string,
        status: "done",
      });
      await waitForIssueStatus(page.request, {
        baseUrl,
        issueId: managerIssue.id,
        status: "done",
      });

      const authoredIssueRes = await page.request.post(
        `${baseUrl}/api/companies/${company.id}/issues`,
        {
          data: {
            title: authoredIssueTitle,
            description: [
              `Create a brand new Hermes native skill named ${authoredSkillName}.`,
              `Write it to ${authoredSkillTargetPath}.`,
              "The skill frontmatter must declare the exact skill name.",
              `Its instructions must tell you to comment exactly "${authoredSkillToken} :: ${authoredSkillPhrase}" on the current issue before finishing.`,
              `After creating the skill, load it through Hermes skill tools and follow it.`,
              "If you use shell env vars in paths, expand them before using file tools. Do not pass a literal $HERMES_HOME path to write_file.",
              "Do not modify any existing installed skill. Create only this new native skill.",
              "After posting the proof comment, mark this issue done.",
            ].join("\n"),
            assigneeAgentId: workerAgentId,
            status: "todo",
          },
        },
      );
      expect(authoredIssueRes.ok()).toBe(true);
      const authoredIssue = await authoredIssueRes.json();

      await waitForIssueComment(page.request, {
        baseUrl,
        issueId: authoredIssue.id,
        contains: `${authoredSkillToken} :: ${authoredSkillPhrase}`,
      });
      await waitForIssueStatus(page.request, {
        baseUrl,
        issueId: authoredIssue.id,
        status: "done",
      });

      const authoredSkillFile = await findFirstExistingPath(
        authoredSkillDirs.map((dir) => path.join(dir, "SKILL.md")),
      );
      expect(authoredSkillFile).toBeTruthy();
      const authoredSkillContent = await fs.readFile(authoredSkillFile as string, "utf8");
      expect(authoredSkillContent).toContain(`name: ${authoredSkillName}`);
      expect(authoredSkillContent).toContain(authoredSkillPhrase);

      await fs.writeFile(
        installedSkillPlanPath,
        [
          "# Executing Plans E2E",
          "",
          "### Task 1: Write the proof file",
          `- Write a file at ${installedSkillProofPath}.`,
          `- The file content must be exactly ${installedSkillProofToken}.`,
          `- Run cat ${installedSkillProofPath} to verify the contents.`,
          `- If the file contains anything else, overwrite it with exactly ${installedSkillProofToken} and verify again before stopping.`,
        ].join("\n"),
        "utf8",
      );

      const installedSkillIssueRes = await page.request.post(
        `${baseUrl}/api/companies/${company.id}/issues`,
        {
          data: {
            title: installedSkillIssueTitle,
            description: [
              `Use the already-installed Hermes native skill named ${installedSkillName}.`,
              `Execute the written plan at ${installedSkillPlanPath}.`,
              `Your first issue comment must copy the executing-plans start announcement verbatim: ${EXECUTING_PLANS_ANNOUNCEMENT}`,
              "Task-specific exact strings and file contents override any generic wording from the loaded skill.",
              "The human pre-approved completing this single-task plan in one batch without using a PR, branch, or worktree.",
              "Do not stop after the skill says to report, wait, or ask for feedback. In this Paperclip child run you must continue until you post the required exact issue comment and mark the issue done.",
              "A narrative assistant reply is not a substitute for the required Paperclip API comment or the final status PATCH.",
              `Before posting the final completion token, run cat ${installedSkillProofPath} and make sure the file content is exactly ${installedSkillProofToken}. If it is not exact, rewrite it and verify again.`,
              `After the plan completes and ${installedSkillProofPath} exists, comment exactly "${installedSkillToken}" on this issue and mark it done.`,
            ].join("\n"),
            assigneeAgentId: workerAgentId,
            status: "todo",
          },
        },
      );
      expect(installedSkillIssueRes.ok()).toBe(true);
      const installedSkillIssue = await installedSkillIssueRes.json();

      const installedSkillComment = await waitForIssueCommentRecord(page.request, {
        baseUrl,
        issueId: installedSkillIssue.id,
        exact: installedSkillToken,
      });
      await waitForIssueStatus(page.request, {
        baseUrl,
        issueId: installedSkillIssue.id,
        status: "done",
      });
      const installedSkillProofContent = await fs.readFile(installedSkillProofPath, "utf8");
      expect(installedSkillProofContent.trim()).toBe(installedSkillProofToken);
      expect(installedSkillComment.createdByRunId).toBeTruthy();
      const installedSkillRunOutput = await waitForRunLogOutput({
        companyId: company.id,
        agentId: workerAgentId,
        runId: installedSkillComment.createdByRunId as string,
      });
      expect(installedSkillRunOutput).toContain("┊ 📚 preparing skill_view…");
      expect(installedSkillRunOutput).toContain("┊ 📚 skill     executing-plans");
      expect(installedSkillRunOutput).toContain(EXECUTING_PLANS_ANNOUNCEMENT);
      expect(installedSkillRunOutput).toContain(installedSkillProofToken);

      const cronIssueRes = await page.request.post(
        `${baseUrl}/api/companies/${company.id}/issues`,
        {
          data: {
            title: cronIssueTitle,
            description: [
              "Use Hermes cron tooling to create exactly one cron job.",
              `The cron job name must be paperclip-cron-${suffix}.`,
              "Use a 30m schedule.",
              `The cron prompt must reply with exactly ${cronResponseToken} and nothing else.`,
              `After the cron job is created, comment exactly "${cronJobCommentPrefix}<job-id>" on this issue, substituting the real Hermes cron job id returned by the tool.`,
              "Do not create more than one cron job.",
              "Mark this issue done after posting the job id comment.",
            ].join("\n"),
            assigneeAgentId: workerAgentId,
            status: "todo",
          },
        },
      );
      expect(cronIssueRes.ok()).toBe(true);
      const cronIssue = await cronIssueRes.json();

      const cronJobComment = await waitForIssueCommentMatch(page.request, {
        baseUrl,
        issueId: cronIssue.id,
        pattern: new RegExp(`${escapeRegExp(cronJobCommentPrefix)}([a-z0-9]+)`),
      });
      const cronJobIdMatch = cronJobComment.match(
        new RegExp(`${escapeRegExp(cronJobCommentPrefix)}([a-z0-9]+)`),
      );
      expect(cronJobIdMatch?.[1]).toBeTruthy();
      const cronJobId = cronJobIdMatch![1];
      await waitForIssueStatus(page.request, {
        baseUrl,
        issueId: cronIssue.id,
        status: "done",
      });

      const cronHome = await findHermesHomeWithCronJob(cronJobId);
      expect(cronHome).toBeTruthy();
      await execHermes(cronHome as string, ["cron", "run", cronJobId]);
      await execHermes(cronHome as string, ["cron", "tick"]);
      const cronArtifact = await waitForCronArtifact(cronHome as string, cronJobId);
      const cronArtifactContent = await fs.readFile(cronArtifact, "utf8");
      expect(cronArtifactContent).toContain(cronResponseToken);
    } finally {
      await fs.rm(installedSkillPlanPath, { force: true });
      await fs.rm(installedSkillProofPath, { force: true });
      for (const authoredSkillDir of authoredSkillDirs) {
        await fs.rm(authoredSkillDir, { recursive: true, force: true });
      }
      for (const nativeSkillDir of nativeSkillDirs) {
        await fs.rm(nativeSkillDir, { recursive: true, force: true });
      }
    }
  });
});
