import { describe, expect, it } from "vitest";
import { AGENT_CONTROL_TERMS, agentControlTermsInReply, chatReplyControlVocabularyCheck } from "./chat-reply-control-vocabulary.js";

// Saved replies recorded in chat-eval cohort 5 (OpenCode, DeepSeek v4.1 flash).
const validReply =
  "The Product Engineering website team is already installed in this company and verified up to date — no duplicate was created.\n\n- [CTO 2](/COM/agents/4f632b86-2af9-4120-879c-4358943ed99f) — Chief Technology Officer, reports to you\n- [QA](/COM/agents/77bc59c2-7026-4fd2-9939-cf08951ebb5a) — QA Engineer, reports to CTO 2";
const brokenReplies = [
  "Task created and already executing (status in_progress, run dafb...). Good. Reply with link. Use finish. Keep concise.\n\nCompletion contract revision 1, criterion \"objective\". I should call paperclip_finish with done. Include evidence refs maybe task link. Let's do.",
  "Confirmed down. Now report honestly.\n\nShould I write a progress comment? Not needed. I'll finish with paperclip_finish. The reportedWorkDisposition: \"done\" (attempted, outcome reported).",
  "Given \"Finish exactly once with paperclip_finish or paperclip_block\", and this is a hard boundary owned by a human (board), \"blocked\" might be semantically wrong.",
  "Installation verified: team present, 3 agents, project and routine. CEO is manager of CTO 2.\n\nThen call paperclip_finish with reportedWorkDisposition done.",
];

describe("agent control vocabulary in replies", () => {
  it("derives its terms from the completion tool contract", () => {
    expect(AGENT_CONTROL_TERMS).toEqual(expect.arrayContaining([
      "paperclip_finish", "paperclip_block", "reportedWorkDisposition", "completionClaim", "objectiveSatisfied", "contractRevision",
    ]));
    // Plain words from the report schema are wording, not identifiers.
    expect(AGENT_CONTROL_TERMS).not.toContain("summary");
    expect(AGENT_CONTROL_TERMS).not.toContain("evidence");
  });

  it("accepts a recorded valid reply", () => {
    expect(agentControlTermsInReply(validReply)).toEqual([]);
  });

  it("accepts reworded replies that use product names, settings and ordinary words", () => {
    for (const reply of [
      "Morgan is an OpenCode `paperclip_runner` agent whose model is currently `openrouter/deepseek`.",
      "If `PAPERCLIP_API_KEY` is set in that terminal, it's used instead of your sign-in.",
      "I finished the report; the summary and evidence are on [COM-2](/COM/issues/COM-2). It is blocked until you approve.",
      "Your assistant can call the `paperclip_finish_task` tool after you connect it.",
    ]) expect(agentControlTermsInReply(reply), reply).toEqual([]);
  });

  it("rejects each recorded reasoning reply", () => {
    for (const reply of brokenReplies) expect(agentControlTermsInReply(reply).length, reply).toBeGreaterThan(0);
  });

  it("grades the conversation's agent replies and ignores setup and human comments", () => {
    const comments = [
      { id: "human", body: "Why is paperclip_finish in my reply?", authorUserId: "user" },
      { id: "setup", body: brokenReplies[0]!, authorAgentId: "agent", createdByRunId: "setup-run" },
      { id: "reply", body: validReply, authorAgentId: "agent", createdByRunId: "run" },
    ];
    expect(chatReplyControlVocabularyCheck({ comments, setupRunIds: ["setup-run"] }).passed).toBe(true);
    const broken = chatReplyControlVocabularyCheck({
      comments: [...comments, { id: "leak", body: brokenReplies[1]!, authorAgentId: "agent", createdByRunId: "run" }],
      setupRunIds: ["setup-run"],
    });
    expect(broken).toMatchObject({ id: "catalog-reply-no-agent-control-terms", passed: false });
    expect(broken.detail).toContain("leak (paperclip_finish, reportedWorkDisposition)");
  });
});
