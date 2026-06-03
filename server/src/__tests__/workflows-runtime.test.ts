import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeWorkflowProject } from "../services/workflows-runtime.js";

describe("workflows runtime analysis", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("ignores closing delimiters inside Python line comments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workflow-runtime-"));
    tempRoots.push(root);
    const agentPath = path.join(root, "agent.py");
    await fs.writeFile(agentPath, `
from google.adk.agents import Agent

def build_outline():
    return "outline"

reviewer = Agent(
    name="Reviewer",
)

root = Agent(
    name="Root",
    # a comment with a closing paren should not end the constructor )
    sub_agents=[reviewer],
    tools=[build_outline],
)

root_agent = root
`, "utf8");

    const analysis = await analyzeWorkflowProject(agentPath);
    expect(analysis.pipelineDefinition.phases.map((phase) => phase.label)).toContain("Reviewer");
    expect(analysis.pipelineDefinition.phases.map((phase) => phase.label)).toContain("build_outline");
  });
});
