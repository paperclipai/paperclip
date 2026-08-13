import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeWorkflowProject,
  prepareInstrumentedWorkflowRuntime,
} from "../services/workflows-runtime.js";

const execFileAsync = promisify(execFile);

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

REVIEWER_INSTRUCTION = """Check the outline for unsupported claims."""

def build_outline():
    return "outline"

reviewer = Agent(
    name="Reviewer",
    instruction=REVIEWER_INSTRUCTION,
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
    expect(
      analysis.pipelineDefinition.phases.find((phase) => phase.label === "Reviewer")?.systemPrompt,
    ).toBe("Check the outline for unsupported claims.");
  });

  it("renders workflow DAG roots and joins for ADK workflows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workflow-runtime-"));
    tempRoots.push(root);
    const agentPath = path.join(root, "agent.py");
    await fs.writeFile(agentPath, `
from google.adk.agents import Agent, JoinNode, Workflow

source_data_node = Agent(
    name="source_data",
)

write_article_1_node = Agent(
    name="write_article_1",
)

write_article_2_node = Agent(
    name="write_article_2",
)

recommend_recycled_articles_node = Agent(
    name="recommend_recycled_articles",
)

ugc_user_questions_node = Agent(
    name="ugc_user_questions",
)

article_output_collector = JoinNode(
    name="article_output_collector",
)

article_feedback_editor_node = Agent(
    name="article_feedback_editor",
)

recycled_article_accuracy_reviewer_node = Agent(
    name="recycled_article_accuracy_reviewer",
)

article_link_checker_node = Agent(
    name="article_link_checker",
)

review_output_router = Agent(
    name="review_output_router",
)

revise_output_node = Agent(
    name="revise_output",
)

workflow = Workflow(
    edges=[
        source_data_node >> write_article_1_node,
        source_data_node >> write_article_2_node,
        source_data_node >> recommend_recycled_articles_node,
        source_data_node >> ugc_user_questions_node,
        write_article_1_node >> article_output_collector,
        write_article_2_node >> article_output_collector,
        recommend_recycled_articles_node >> article_output_collector,
        ugc_user_questions_node >> article_output_collector,
        article_output_collector >> article_feedback_editor_node,
        article_feedback_editor_node >> recycled_article_accuracy_reviewer_node,
        recycled_article_accuracy_reviewer_node >> article_link_checker_node,
        article_link_checker_node >> review_output_router,
        review_output_router >> {"source_data_node": article_feedback_editor_node, "APPROVED": revise_output_node},
    ],
)

root_agent = workflow
`, "utf8");

    const analysis = await analyzeWorkflowProject(agentPath);
    const phasesByLabel = new Map(analysis.pipelineDefinition.phases.map((phase) => [phase.label, phase] as const));
    const labels = [...phasesByLabel.keys()];
    const sourceData = phasesByLabel.get("source_data");
    const writeArticle1 = phasesByLabel.get("write_article_1");
    const writeArticle2 = phasesByLabel.get("write_article_2");
    const recommendRecycledArticles = phasesByLabel.get("recommend_recycled_articles");
    const ugcUserQuestions = phasesByLabel.get("ugc_user_questions");
    const collector = phasesByLabel.get("article_output_collector");
    const feedbackEditor = phasesByLabel.get("article_feedback_editor");
    const reviewer = phasesByLabel.get("recycled_article_accuracy_reviewer");
    const linkChecker = phasesByLabel.get("article_link_checker");
    const router = phasesByLabel.get("review_output_router");
    const reviseOutput = phasesByLabel.get("revise_output");

    expect(labels).toEqual(
      expect.arrayContaining([
        "source_data",
        "write_article_1",
        "write_article_2",
        "recommend_recycled_articles",
        "ugc_user_questions",
        "article_output_collector",
        "article_feedback_editor",
        "recycled_article_accuracy_reviewer",
        "article_link_checker",
        "review_output_router",
        "revise_output",
      ]),
    );
    expect(sourceData?.parentKey).toBeNull();
    expect(writeArticle1?.parentKey).toBe(sourceData?.key);
    expect(writeArticle2?.parentKey).toBe(sourceData?.key);
    expect(recommendRecycledArticles?.parentKey).toBe(sourceData?.key);
    expect(ugcUserQuestions?.parentKey).toBe(sourceData?.key);
    expect(collector?.parentKey).toBeDefined();
    expect(collector?.parentKeys).toEqual(
      expect.arrayContaining([
        writeArticle1?.key,
        writeArticle2?.key,
        recommendRecycledArticles?.key,
        ugcUserQuestions?.key,
      ]),
    );
    expect(collector?.parentKeys).toHaveLength(4);
    expect(feedbackEditor?.parentKey).toBe(collector?.key);
    expect(reviewer?.parentKey).toBe(feedbackEditor?.key);
    expect(linkChecker?.parentKey).toBe(reviewer?.key);
    expect(router?.parentKey).toBe(linkChecker?.key);
    expect(reviseOutput?.parentKey).toBe(router?.key);
  });

  it("prefers the entry file when falling back to a root ADK variable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workflow-runtime-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "agent.py"), `
from google.adk.agents import Agent

entry_agent = Agent(
    name="entry_agent",
)
`, "utf8");
    await fs.writeFile(path.join(root, "a_helper.py"), `
from google.adk.agents import Agent, Workflow

helper_source = Agent(
    name="helper_source",
)

helper_sink = Agent(
    name="helper_sink",
)

workflow = Workflow(
    edges=[
        helper_source >> helper_sink,
    ],
)
`, "utf8");

    const analysis = await analyzeWorkflowProject(root);
    expect(analysis.entrypoint).toBe("agent.py");
    expect(analysis.pipelineDefinition.phases.map((phase) => phase.label)).toEqual(["entry_agent"]);
  });

  it("analyzes imported LlmAgents and local skills from a package parent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workflow-runtime-"));
    tempRoots.push(root);
    const workflowDir = path.join(root, "instagram_post_generator");
    const agentsDir = path.join(root, "agents");
    const servicesDir = path.join(root, "services");
    const skillDir = path.join(root, "skills", "instagram-writer");
    await Promise.all([
      fs.mkdir(workflowDir, { recursive: true }),
      fs.mkdir(agentsDir, { recursive: true }),
      fs.mkdir(servicesDir, { recursive: true }),
      fs.mkdir(skillDir, { recursive: true }),
    ]);
    await fs.writeFile(path.join(workflowDir, "agent.py"), `
from google.adk import Workflow
from agents.intake_agent import intake_agent
from agents.writer_agent import writer_agent
from services.pipeline import intake, write

root_agent = Workflow(name="instagram", edges=[("START", intake), (intake, write)])
`, "utf8");
    await fs.writeFile(path.join(agentsDir, "intake_agent.py"), `
from google.adk.agents import LlmAgent
intake_agent = LlmAgent(name="platform_intake_agent", instruction="Parse the brief")
`, "utf8");
    await fs.writeFile(path.join(agentsDir, "writer_agent.py"), `
from google.adk.agents import LlmAgent
writer_agent = LlmAgent(
    name="instagram_post_writer_agent",
    instruction=f"""Use this skill: {_skill("instagram-writer")}""",
)
`, "utf8");
    await fs.writeFile(path.join(servicesDir, "pipeline.py"), `
def intake(node_input): return node_input
def write(node_input): return node_input
`, "utf8");
    await fs.writeFile(path.join(skillDir, "SKILL.md"), `---
name: instagram-writer
description: Write Instagram posts.
---
Use only supplied facts.
`, "utf8");
    await fs.mkdir(path.join(root, "resource_tester"), { recursive: true });
    await fs.writeFile(path.join(root, "resource_tester", "agent.py"), `
from google.adk.agents import Agent
root_agent = Agent(name="unrelated_resource_tester")
`, "utf8");

    const analysis = await analyzeWorkflowProject(workflowDir);
    const agents = analysis.pipelineDefinition.phases.filter((phase) => phase.kind === "agent");

    expect(analysis.rootDir).toBe(root);
    expect(analysis.entrypoint).toBe("instagram_post_generator/agent.py");
    expect(analysis.executionTargetPath).toBe(workflowDir);
    expect(analysis.pipelineDefinition.phases.map((phase) => phase.label)).toEqual(
      expect.arrayContaining(["Intake", "Write"]),
    );
    expect(agents.map((phase) => phase.label)).toEqual([
      "platform_intake_agent",
      "instagram_post_writer_agent",
    ]);
    expect(agents.find((phase) => phase.label === "instagram_post_writer_agent")?.configuredSkills)
      .toEqual([expect.objectContaining({
        name: "instagram-writer",
        content: expect.stringContaining("Use only supplied facts."),
      })]);
  });

  it("keeps future imports ahead of the injected workflow runtime import", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workflow-runtime-"));
    tempRoots.push(root);
    const agentPath = path.join(root, "agent.py");
    await fs.writeFile(agentPath, `from __future__ import annotations

from google.adk.agents import Agent

def build_outline():
    return "outline"

root_agent = Agent(name="writer", tools=[build_outline])
`, "utf8");

    const analysis = await analyzeWorkflowProject(root);
    const prepared = await prepareInstrumentedWorkflowRuntime({
      workflowId: "workflow-1",
      runId: "run-future-import",
      companyId: "company-1",
      runnerConfig: { agentPath: root },
      analysis,
      runToken: "token",
    });
    tempRoots.push(prepared.tempRoot, prepared.runtimeRoot);

    const stagedAgentPath = path.join(prepared.tempRoot, "project", "agent.py");
    const stagedAgent = await fs.readFile(stagedAgentPath, "utf8");
    expect(stagedAgent.indexOf("from __future__ import annotations"))
      .toBeLessThan(stagedAgent.indexOf("from bizbox_workflow_runtime import workflow_phase"));
    await expect(execFileAsync(
      "python3",
      ["-m", "py_compile", stagedAgentPath],
      { env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(prepared.tempRoot, "pycache") } },
    ))
      .resolves.toBeDefined();
  });

  it("installs live runtime telemetry for model, prompt, instruction, and tools", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workflow-runtime-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "agent.py"), `
from google.adk.agents import Agent

root_agent = Agent(name="writer", instruction="Write clearly")
`, "utf8");
    await fs.mkdir(path.join(root, ".venv"), { recursive: true });
    await fs.writeFile(path.join(root, ".venv", "large-dependency.py"), "ignored", "utf8");
    const analysis = await analyzeWorkflowProject(root);
    const prepared = await prepareInstrumentedWorkflowRuntime({
      workflowId: "workflow-1",
      runId: "run-telemetry",
      companyId: "company-1",
      runnerConfig: { agentPath: root },
      analysis,
      runToken: "token",
    });
    tempRoots.push(prepared.tempRoot, prepared.runtimeRoot);
    await expect(fs.stat(path.join(prepared.tempRoot, "project", ".venv"))).rejects.toMatchObject({ code: "ENOENT" });

    const helper = await fs.readFile(path.join(prepared.tempRoot, "bizbox_workflow_runtime.py"), "utf8");
    expect(helper).toContain('"runtimeAgent": True');
    expect(helper).toContain('"schema": "bizbox.telemetry/v1"');
    expect(helper).toContain("def observed_operation(");
    expect(helper).toContain("def telemetry_operation(");
    expect(helper).toContain('"[redacted]"');
    expect(helper).toContain('"model": _model_name(agent)');
    expect(helper).toContain('"systemPrompt": instruction');
    expect(helper).toContain('"prompt": _prompt_from_call(args, kwargs)');
    expect(helper).toContain('"configuredTools": _tool_names(agent)');
    expect(helper).toContain('"runtimeKind": "tool"');
    expect(helper).toContain('"runtimeToolInput": _json_safe_output');
    expect(helper).toContain('target = sys.modules.get("shared.service.image_generator")');
    expect(helper).toContain('"prompt": call_input["prompt"]');
    expect(helper).toContain('"runtimeToolName": "generate_image"');
    expect(helper).toContain('"runtimeToolOutput": _image_call_output(result)');
    expect(helper).toContain('"output": _image_call_output(result)');
    expect(helper).toContain("@functools.wraps(fn)");
    expect(helper).toContain("def _output_from_value(value):");
    expect(helper).toContain('{"output": observed_output}');
    await expect(execFileAsync(
      "python3",
      ["-m", "py_compile", path.join(prepared.tempRoot, "bizbox_workflow_runtime.py")],
      { env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(prepared.tempRoot, "pycache") } },
    ))
      .resolves.toBeDefined();

    const fakePackageRoot = path.join(prepared.tempRoot, "fake-package");
    const fakeImageModule = path.join(fakePackageRoot, "shared", "service", "image_generator");
    const fakeAgentsModule = path.join(fakePackageRoot, "google", "adk", "agents");
    const fakeToolsModule = path.join(fakePackageRoot, "google", "adk", "tools");
    await fs.mkdir(fakeImageModule, { recursive: true });
    await fs.mkdir(fakeAgentsModule, { recursive: true });
    await fs.mkdir(fakeToolsModule, { recursive: true });
    await fs.writeFile(path.join(fakePackageRoot, "shared", "__init__.py"), "", "utf8");
    await fs.writeFile(path.join(fakePackageRoot, "shared", "service", "__init__.py"), "", "utf8");
    await fs.writeFile(path.join(fakeImageModule, "__init__.py"), `
class Result:
    saved_path = "/tmp/generated.png"
    content_type = "image/png"
    byte_length = 42
    job_id = "job-1"

def generate_image(**kwargs):
    return Result()
`, "utf8");
    await fs.writeFile(path.join(fakePackageRoot, "google", "__init__.py"), "", "utf8");
    await fs.writeFile(path.join(fakePackageRoot, "google", "adk", "__init__.py"), "", "utf8");
    await fs.writeFile(path.join(fakeAgentsModule, "__init__.py"), `
class BaseAgent:
    async def run_async(self, *args, **kwargs):
        if False:
            yield None
`, "utf8");
    await fs.writeFile(path.join(fakeToolsModule, "__init__.py"), "", "utf8");
    await fs.writeFile(path.join(fakeToolsModule, "base_tool.py"), `
class BaseTool:
    async def run_async(self, *, args, tool_context):
        return args
`, "utf8");
    await fs.writeFile(path.join(fakeToolsModule, "function_tool.py"), `
from .base_tool import BaseTool

class FunctionTool(BaseTool):
    name = "lookup_submissions"

    async def run_async(self, *, args, tool_context):
        return {"rows": 25, "query": args}
`, "utf8");
    const executed = await execFileAsync("python3", [
      "-c",
      "import shared.service.image_generator as image_generator; result = image_generator.generate_image(prompt='exact prompt'); print(getattr(image_generator.generate_image, '__bizbox_wrapped__', False)); print(result.job_id)",
    ], {
      env: {
        ...process.env,
        PYTHONPATH: [prepared.tempRoot, fakePackageRoot].join(path.delimiter),
        PYTHONPYCACHEPREFIX: path.join(prepared.tempRoot, "pycache"),
      },
    });
    expect(executed.stdout.trim().split(/\r?\n/)).toEqual(["True", "job-1"]);

    const toolExecution = await execFileAsync("python3", [
      "-c",
      `import asyncio, json
import bizbox_workflow_runtime as runtime
from google.adk.tools.function_tool import FunctionTool
events = []
runtime._safe_emit_phase = lambda key, label, status, metadata=None: events.append({"key": key, "label": label, "status": status, "metadata": metadata})
result = asyncio.run(FunctionTool().run_async(args={"month": "July"}, tool_context=None))
print(getattr(FunctionTool.run_async, "__bizbox_tool_wrapped__", False))
print(json.dumps(events, separators=(",", ":")))
print(json.dumps(result, separators=(",", ":")))`,
    ], {
      env: {
        ...process.env,
        PYTHONPATH: [prepared.tempRoot, fakePackageRoot].join(path.delimiter),
        PYTHONPYCACHEPREFIX: path.join(prepared.tempRoot, "pycache"),
      },
    });
    const [wrapped, eventsJson, resultJson] = toolExecution.stdout.trim().split(/\r?\n/);
    expect(wrapped).toBe("True");
    expect(JSON.parse(eventsJson ?? "[]")).toEqual([
      expect.objectContaining({
        label: "lookup_submissions",
        status: "running",
        metadata: expect.objectContaining({
          runtimeKind: "tool",
          runtimeToolInput: { month: "July" },
        }),
      }),
      expect.objectContaining({
        status: "succeeded",
        metadata: { runtimeToolOutput: { rows: 25, query: { month: "July" } } },
      }),
    ]);
    expect(JSON.parse(resultJson ?? "null")).toEqual({ rows: 25, query: { month: "July" } });

    const telemetryExecution = await execFileAsync("python3", [
      "-c",
      `import json
import bizbox_workflow_runtime as runtime
payloads = []
runtime._request = lambda method, path, payload=None: payloads.append({"method": method, "path": path, "payload": payload}) or {}
span_id = runtime.emit_operation_started("partnerpal", "tool", {"query": "campaign ideas", "api_key": "secret"}, "tool")
runtime.emit_operation_completed(span_id, "partnerpal", "tool", {"matches": 1}, "tool")
print(json.dumps(payloads, separators=(",", ":")))`,
    ], {
      env: {
        ...process.env,
        PYTHONPATH: prepared.tempRoot,
        PYTHONPYCACHEPREFIX: path.join(prepared.tempRoot, "pycache"),
      },
    });
    const telemetryPayloads = JSON.parse(telemetryExecution.stdout.trim());
    expect(telemetryPayloads).toHaveLength(2);
    expect(telemetryPayloads[0]).toMatchObject({
      method: "POST",
      path: "/api/workflow-runs//runtime/telemetry-events",
      payload: {
        events: [expect.objectContaining({
          schema: "bizbox.telemetry/v1",
          event: "operation.started",
          operation: { kind: "tool", name: "partnerpal" },
          input: { query: "campaign ideas", api_key: "[redacted]" },
        })],
      },
    });
  });
});
