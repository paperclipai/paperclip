import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHermesPaperclipPrompt } from "../adapters/hermes-paperclip-prompt.js";
import { buildAgentRunContextBundle } from "../services/agent-run-context-bundle.js";

describe("buildHermesPaperclipPrompt", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("prepends Paperclip managed instructions and replaces Hermes default heartbeat prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-instructions-"));
    tempDirs.push(root);
    const instructionsFilePath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, "You are the CTO.\n", "utf8");

    const { promptTemplate, instructionsRootPath, logNotes } = await buildHermesPaperclipPrompt({
      adapterConfig: {
        instructionsFilePath,
        instructionsRootPath: root,
      },
      context: {},
      runtime: {},
    });

    expect(instructionsRootPath).toBe(root);
    expect(logNotes.some((note) => note.includes("Loaded Paperclip managed instructions"))).toBe(true);
    expect(promptTemplate).toContain("You are the CTO.");
    expect(promptTemplate).toContain("Loaded from Paperclip bundle");
    expect(promptTemplate).toContain("Paperclip Timer Heartbeat");
    expect(promptTemplate).not.toContain("terminal` tool with `curl`");
  });

  it("writes and injects the native Agent Run Context Bundle for Hermes local wakes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-context-bundle-"));
    tempDirs.push(root);
    const instructionsFilePath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, "You are the CTO.\n", "utf8");

    const paperclipRunContext = buildAgentRunContextBundle({
      company: {
        id: "company-1",
        name: "Baby Tracker",
        description: "Small human-supervised product team.",
      },
      agent: {
        id: "agent-cto",
        name: "CTO",
        role: "engineering_manager",
        title: "Chief Technology Officer",
        permissions: { update_issue: true, comment_on_issue: true },
        reportsTo: "agent-ceo",
      },
      issue: {
        id: "issue-998",
        identifier: "BAB-998",
        title: "Design native Agent Run Context Bundle",
        description: "Reduce basic MCP rediscovery.",
        status: "in_progress",
        priority: "high",
        workMode: "standard",
      },
      graph: {
        parent: {
          id: "issue-997",
          identifier: "BAB-997",
          title: "Define native context bundle",
          status: "done",
          priority: "high",
        },
        blocking: [],
        dependent: [],
        linked: [{
          id: "issue-996",
          identifier: "BAB-996",
          title: "Related bootstrap work",
          status: "done",
          priority: "medium",
        }],
      },
      workspace: {
        path: root,
        repo: "git@github.com:paperclipai/paperclip.git",
        branch: "feat/context-bundle",
        dirtyStatus: "dirty",
        openPrs: [{ number: 12, url: "https://github.com/paperclipai/paperclip/pull/12" }],
      },
      run: {
        id: "run-1",
        wakeReason: "issue_assigned",
      },
    });

    const { promptTemplate, logNotes } = await buildHermesPaperclipPrompt({
      adapterConfig: {
        instructionsFilePath,
        instructionsRootPath: root,
      },
      context: { paperclipRunContext },
      runtime: {},
    });

    expect(promptTemplate).toContain("Paperclip Agent Run Context Bundle");
    expect(promptTemplate).toContain("company: Baby Tracker");
    expect(promptTemplate).toContain("agent: CTO (engineering_manager)");
    expect(promptTemplate).toContain("issue: BAB-998 Design native Agent Run Context Bundle (in_progress)");
    expect(promptTemplate).toContain("linked issues");
    expect(promptTemplate).toContain("BAB-996 Related bootstrap work (done)");
    expect(promptTemplate).toContain("MCP/API remains for live refresh");
    expect(promptTemplate).toContain("agent/run identity");
    expect(logNotes.some((note) => note.includes("Agent Run Context Bundle files"))).toBe(true);

    const contextRoot = path.join(root, ".paperclip", "context");
    const companyJson = JSON.parse(await fs.readFile(path.join(contextRoot, "company.json"), "utf8"));
    const agentJson = JSON.parse(await fs.readFile(path.join(contextRoot, "agent.json"), "utf8"));
    const issueJson = JSON.parse(await fs.readFile(path.join(contextRoot, "issue.json"), "utf8"));
    const workspaceJson = JSON.parse(await fs.readFile(path.join(contextRoot, "workspace.json"), "utf8"));
    const policiesMd = await fs.readFile(path.join(contextRoot, "policies.md"), "utf8");

    expect(companyJson).toMatchObject({ name: "Baby Tracker" });
    expect(agentJson).toMatchObject({ name: "CTO", reportsTo: "agent-ceo" });
    expect(issueJson.issue).toMatchObject({ identifier: "BAB-998" });
    expect(issueJson.graph.parent).toMatchObject({ identifier: "BAB-997" });
    expect(workspaceJson).toMatchObject({ path: root, branch: "feat/context-bundle" });
    expect(policiesMd).toContain("MCP/API role");
  });

  it("skips full AGENTS.md reinjection on resumed scoped wake", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-instructions-"));
    tempDirs.push(root);
    const instructionsFilePath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, "You are the CTO.\n", "utf8");

    const { promptTemplate, logNotes } = await buildHermesPaperclipPrompt({
      adapterConfig: {
        instructionsFilePath,
        instructionsRootPath: root,
      },
      context: {
        paperclipWake: {
          reason: "comment",
          issue: { id: "issue-1", identifier: "BAB-1", title: "Launch plan" },
          comments: [{ id: "comment-1", body: "Please revise scope." }],
          includedCount: 1,
          requestedCount: 1,
          latestCommentId: "comment-1",
          fallbackFetchNeeded: false,
        },
      },
      runtime: { sessionParams: { sessionId: "sess-123" } },
    });

    expect(logNotes.some((note) => note.includes("Skipped static instruction reinjection"))).toBe(true);
    expect(promptTemplate).not.toContain("You are the CTO.");
    expect(promptTemplate).toContain("Paperclip Resume Delta");
    expect(promptTemplate).not.toContain("Paperclip Timer Heartbeat");
  });
});
