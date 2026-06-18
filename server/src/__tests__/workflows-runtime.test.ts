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
});
