import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope, AskUserQuestionsInteraction } from "@paperclipai/shared";

import { formatDurableQuestionResponseSummary } from "../question-response-delivery.js";
import { nativeCompletionSource, buildNativeCompletionContract } from "./completion-contracts.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

describe("native execution input external-chat framing", () => {
  it.each([false, true])(
    "projects the authoritative selected answer into an attested native chat prompt (resumed: %s)",
    (resumedSession) => {
      const interactionId = "80000000-0000-4000-8000-000000000008";
      const sourceRunId = "90000000-0000-4000-8000-000000000009";
      const wakePayload = {
        reason: "issue_commented",
        externalChatProvider: "telegram",
        externalChatExecutionBound: true,
        interactionId,
        sourceRunId,
        interactionKind: "ask_user_questions",
        interactionStatus: "answered",
        externalInteractionContinuation: true,
        issue: {
          id: "20000000-0000-4000-8000-000000000002",
          workMode: "standard",
          status: "in_review",
        },
        externalChatQuestionResponse: {
          schema: "paperclip.external_chat_question_response.v1",
          interactionId,
          sourceRunId,
          responseDeliveryId: "10000000-0000-4000-8000-000000000011",
          sourceCommentId: "10000000-0000-4000-8000-000000000012",
          endpointId: "10000000-0000-4000-8000-000000000013",
          conversationId: "10000000-0000-4000-8000-000000000014",
          bindingSha256: "a".repeat(64),
        },
        commentIds: ["10000000-0000-4000-8000-000000000012"],
        latestCommentId: "10000000-0000-4000-8000-000000000012",
        comments: [
          {
            id: "10000000-0000-4000-8000-000000000012",
            body: "Ask for a color, then tell me the selected color.",
          },
        ],
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        fallbackFetchNeeded: false,
      };
      const args: Parameters<typeof buildNativeExecutionInput>[0] = {
        companyId: "10000000-0000-4000-8000-000000000001",
        runId: "50000000-0000-4000-8000-000000000005",
        agentId: "30000000-0000-4000-8000-000000000003",
        issue: {
          id: "20000000-0000-4000-8000-000000000002",
          identifier: "CHAT-5",
          title: "Old exact-output request",
          description: null,
          workMode: "standard",
        },
        taskPrompt:
          "Continue the user's original request with their selected answer.",
        initialCommunicationGuidance: "Initial Slack communication preferences.",
        wakePayload,
        resumedSession,
        workspace: {
          id: "50000000-0000-4000-8000-000000000005",
          cwd: "/workspace",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        normalizedSessionId: "60000000-0000-4000-8000-000000000006",
        provider: "codex",
        completionContract: {
          id: "70000000-0000-4000-8000-000000000007",
          sha256: `sha256:${"a".repeat(64)}`,
          schemaVersion: "paperclip.run-result.v1",
          contract: {
            revision: "1",
            objective: "Answer the user's selected choice",
            criteria: [
              { id: "answer", requirement: "Return the actual color." },
            ],
          },
        },
        runtimeContext: nativeRuntimeContextFixture(),
        interactionResponses: [
          {
            interactionId,
            kind: "ask_user_questions",
            response: {
              status: "answered",
              result: {
                version: 1,
                answers: [{ questionId: "color", optionIds: ["amber"] }],
                summaryMarkdown:
                  "Resolved questions and answers:\n- Choose a color: Amber",
              },
            },
          },
        ],
      };
      const input = buildNativeExecutionInput(args);
      expect(input.initialCommunicationGuidance).toBe("Initial Slack communication preferences.");
      // The runtime adds this only after deciding whether provider recovery succeeded.
      expect(input.task.prompt).not.toContain("Initial Slack communication preferences.");
      expect(input.task.title).toBe("External chat follow-up");
      expect(input.task.prompt).toContain("Amber");
      expect(input.task.prompt).not.toContain("## Questions that need a user response");
      expect(input.task.prompt).toContain(
        "semantic completion summary is the user-visible final answer",
      );
      expect(input.task.prompt).not.toContain(
        "including marking the task done",
      );
      expect(input.task.prompt.indexOf("Choose a color: Amber")).toBeLessThan(
        input.task.prompt.indexOf(
          "Ask for a color, then tell me the selected color.",
        ),
      );
      expect(wakePayload).not.toHaveProperty("questionResponse");

      const mixedModalSummary = formatDurableQuestionResponseSummary({
        id: interactionId,
        kind: "ask_user_questions",
        status: "answered",
        sourceRunId,
        payload: {
          version: 1,
          questions: [
            {
              id: "environment",
              prompt: "Choose an environment",
              selectionMode: "single",
              options: [
                { id: "maple", label: "Maple" },
                { id: "cedar", label: "Cedar" },
              ],
            },
            {
              id: "label",
              prompt: "Enter the verification label",
              selectionMode: "single",
              options: [
                {
                  id: "custom",
                  label: "Custom label",
                  freeText: true,
                },
              ],
            },
          ],
        },
        result: {
          version: 1,
          answers: [
            { questionId: "environment", optionIds: ["maple"] },
            {
              questionId: "label",
              optionIds: [],
              otherText: "amber compass 93",
            },
          ],
          summaryMarkdown: null,
        },
      } as unknown as AskUserQuestionsInteraction);
      const mixedModal = buildNativeExecutionInput({
        ...args,
        wakePayload: {
          ...wakePayload,
          comments: [
            {
              ...wakePayload.comments[0],
              body: "Ask a NEW environment and verification-label question.",
            },
          ],
        },
        interactionResponses: [
          {
            interactionId,
            kind: "ask_user_questions",
            response: {
              status: "answered",
              result: {
                version: 1,
                answers: [
                  { questionId: "environment", optionIds: ["maple"] },
                  {
                    questionId: "label",
                    optionIds: [],
                    otherText: "amber compass 93",
                  },
                ],
                summaryMarkdown: mixedModalSummary,
              },
            },
          },
        ],
      });
      expect(mixedModalSummary).toContain("Maple");
      expect(mixedModalSummary).toContain("amber compass 93");
      expect(mixedModal.task.prompt.indexOf("Maple")).toBeLessThan(
        mixedModal.task.prompt.indexOf("Ask a NEW environment"),
      );
      expect(mixedModal.task.prompt.indexOf("amber compass 93")).toBeLessThan(
        mixedModal.task.prompt.indexOf("Ask a NEW environment"),
      );
      expect(mixedModal.task.prompt).toContain(
        "only the answered questions listed above are resolved",
      );
      const unbound = buildNativeExecutionInput({
        ...args,
        interactionResponses: [
          {
            ...args.interactionResponses![0]!,
            interactionId: "10000000-0000-4000-8000-000000000019",
          },
        ],
      });
      expect(unbound.task.title).toBe("Old exact-output request");
      expect(unbound.task.prompt).not.toContain(
        "Native external-chat questions",
      );
      const earlierInteractionId = "10000000-0000-4000-8000-000000000020";
      const sequential = buildNativeExecutionInput({
        ...args,
        interactionResponses: [
          {
            interactionId: earlierInteractionId,
            kind: "ask_user_questions",
            response: {
              status: "answered",
              result: {
                version: 1,
                answers: [{ questionId: "shape", optionIds: ["circle"] }],
                summaryMarkdown: "Choose a shape: Circle",
              },
            },
          },
          ...args.interactionResponses!,
        ],
      });
      expect(sequential.task.title).toBe("External chat follow-up");
      expect(sequential.task.prompt).toContain("Circle");
      expect(sequential.task.prompt).toContain("Amber");
      expect(sequential.task.prompt).not.toContain("## Questions that need a user response");
      expect(
        sequential.task.prompt.indexOf("Choose a shape: Circle"),
      ).toBeLessThan(sequential.task.prompt.indexOf("Choose a color: Amber"));
      expect(
        sequential.interactionResponses.map(
          (response) => response.interactionId,
        ),
      ).toEqual([earlierInteractionId, interactionId]);
      expect(wakePayload).not.toHaveProperty("questionResponse");
    },
  );
  it.each([false, true])(
    "uses neutral framing and real question tools for authenticated overflow chat (resumed: %s)",
    (resumedSession) => {
      const staleRootTitle = "Reply with exactly STALE-OVERFLOW-MARKER";
      const input = buildNativeExecutionInput({
        companyId: "10000000-0000-4000-8000-000000000001",
        runId: "50000000-0000-4000-8000-000000000005",
        issue: {
          id: "20000000-0000-4000-8000-000000000002",
          identifier: "CHAT-5",
          title: staleRootTitle,
          description: "Started from Discord.",
          workMode: "standard",
        },
        taskPrompt: `Paperclip task context:\n- Title: ${JSON.stringify(staleRootTitle)}`,
        resumedSession,
        wakePayload: {
          reason: "External chat message received",
          externalChatProvider: "discord",
          checkedOutByHarness: true,
          issue: {
            id: "20000000-0000-4000-8000-000000000002",
            identifier: "CHAT-5",
            title: staleRootTitle,
            description: "Started from Discord.",
            descriptionTruncated: false,
            status: "in_progress",
            workMode: "standard",
          },
          commentWindow: {
            requestedCount: 2,
            includedCount: 1,
            missingCount: 1,
          },
          commentIds: ["comment-overflow-1", "comment-overflow-2"],
          latestCommentId: "comment-overflow-2",
          comments: [
            {
              id: "comment-overflow-2",
              issueId: "20000000-0000-4000-8000-000000000002",
              body: "Answer both queued messages.",
              bodyTruncated: false,
              authorType: "user",
            },
          ],
          fallbackFetchNeeded: true,
        },
        agentId: "30000000-0000-4000-8000-000000000003",
        workspace: {
          id: "50000000-0000-4000-8000-000000000005",
          cwd: "/workspace",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        normalizedSessionId: "60000000-0000-4000-8000-000000000006",
        provider: "codex",
        completionContract: {
          id: "70000000-0000-4000-8000-000000000007",
          sha256: `sha256:${"a".repeat(64)}`,
          schemaVersion: "paperclip.run-result.v1",
          contract: {
            revision: "1",
            objective: "Respond to all pending comments in order",
            criteria: [
              {
                id: "objective",
                requirement: "Read every current wake comment.",
              },
            ],
          },
        },
        runtimeContext: nativeRuntimeContextFixture(),
      });

      expect(input.task.title).toBe("External chat follow-up");
      expect(input.task.description).toBeNull();
      expect(input.task.prompt).toContain("read_current_wake_comments");
      expect(input.task.prompt).toContain(staleRootTitle);
    },
  );

  it.each([false, true])(
    "keeps GitHub's task-only files and service-owned recovery navigation in the closed native input (resumed: %s)",
    (resumedSession) => {
      const args: Parameters<typeof buildNativeExecutionInput>[0] = {
        companyId: "10000000-0000-4000-8000-000000000001",
        runId: "50000000-0000-4000-8000-000000000005",
        issue: {
          id: "20000000-0000-4000-8000-000000000002",
          identifier: "CHAT-5",
          title: "Send a file",
          description: null,
          workMode: "standard",
        },
        taskPrompt: "Answer the current line review.",
        wakePayload: {
          reason: "External chat message received",
          externalChatProvider: "github",
          checkedOutByHarness: true,
          issue: {
            id: "20000000-0000-4000-8000-000000000002",
            workMode: "standard",
          },
          comments: [
            {
              id: "review-comment",
              body: "Make a text file and attach it here.",
            },
          ],
          commentIds: ["review-comment"],
          latestCommentId: "review-comment",
          commentWindow: {
            requestedCount: 1,
            includedCount: 1,
            missingCount: 0,
          },
          fallbackFetchNeeded: false,
        },
        resumedSession,
        agentId: "30000000-0000-4000-8000-000000000003",
        workspace: {
          id: "50000000-0000-4000-8000-000000000005",
          cwd: "/workspace",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        normalizedSessionId: "60000000-0000-4000-8000-000000000006",
        provider: "codex",
        completionContract: {
          id: "70000000-0000-4000-8000-000000000007",
          sha256: `sha256:${"a".repeat(64)}`,
          schemaVersion: "paperclip.run-result.v1",
          contract: {
            revision: "1",
            objective: "Prepare a file",
            criteria: [
              { id: "objective", requirement: "Describe actual delivery." },
            ],
          },
        },
        runtimeContext: nativeRuntimeContextFixture(),
      };
      const input = buildNativeExecutionInput(args);
      expect(input.task.prompt).toContain(
        "This GitHub App connection cannot upload file bytes into comments or review threads",
      );
      expect(input.task.prompt).toContain(
        "do not say it is attached, displayed, downloadable, or available to open in this provider conversation",
      );
      expect(input.task.prompt).toContain(
        "Preparation does not confirm provider delivery",
      );
      expect(input.task.prompt).toContain(
        "Paperclip owns recovery navigation for unavailable GitHub attachments",
      );
      expect(input.task.prompt).toContain(
        "after an accepted response, only when the current source remains authorized and a safe configured Board URL is available",
      );
      expect(input.task.prompt).toContain(
        "A task URL missing from your prompt or tool results is not evidence that no task link can be provided",
      );
      expect(input.task.prompt).toContain(
        "Do not invent a URL or promise that a link will appear",
      );
      expect(input.task.prompt).toContain(
        "Briefly explain the unavailable input and ask the user to attach it directly to this Paperclip task or paste the needed text",
      );
      expect(input.task.prompt).toContain(
        "Never infer the file's contents or substitute an older file",
      );

      const wake = args.wakePayload as Record<string, unknown>;
      for (const patch of [
        { externalChatProvider: "slack" },
        { externalChatProvider: "discord" },
        { externalChatProvider: "telegram" },
        { externalChatProvider: "microsoft-teams" },
        { externalChatProvider: null },
        { externalChatProvider: "GitHub" },
        { checkedOutByHarness: false },
      ]) {
        const unrelated = buildNativeExecutionInput({
          ...args,
          wakePayload: { ...wake, ...patch },
        });
        expect(unrelated.task.prompt).not.toContain(
          "Paperclip owns recovery navigation for unavailable GitHub attachments",
        );
      }
    },
  );
  it.each([
    { provider: "codex", resumedSession: false },
    { provider: "codex", resumedSession: true },
    { provider: "acpx", resumedSession: false },
    { provider: "acpx", resumedSession: true },
    { provider: "opencode", resumedSession: false },
    { provider: "opencode", resumedSession: true },
  ] as const)("keeps question documentation in the tool on $provider (resumed: $resumedSession)", ({ provider, resumedSession }) => {
    const input = buildNativeExecutionInput({
      companyId: "10000000-0000-4000-8000-000000000001",
      runId: "50000000-0000-4000-8000-000000000005",
      agentId: "30000000-0000-4000-8000-000000000003",
      issue: { id: "20000000-0000-4000-8000-000000000002", identifier: "QA-1", title: "Welcome", description: null, workMode: "standard" },
      taskPrompt: "Ask whether the welcome should sound warm or formal before writing it.",
      workspace: { id: "40000000-0000-4000-8000-000000000004", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: resumedSession ? "60000000-0000-4000-8000-000000000006" : null,
      provider, resumedSession,
      acpxAgent: "claude",
      model: provider === "acpx" ? "claude-sonnet-5" : provider === "opencode" ? "openai/gpt-5.5" : "gpt-5.6-sol",
      completionContract: {
        id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Write a welcome after the user's answer", criteria: [{ id: "objective", requirement: "Use the selected tone" }] },
      },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(input.provider).toMatchObject(provider === "acpx"
      ? { kind: "acpx", permissionMode: "approve-all" }
      : provider === "opencode" ? { kind: "opencode", permissionMode: "allow" }
      : { kind: "codex", approvalPolicy: "never" });
    expect(input.task.prompt).not.toContain("## Questions that need a user response");
    expect(input.task.prompt).toContain("Use Paperclip's request_human_input for durable task questions.");
    expect(input.task.prompt).not.toContain("payload.questionSet");
  });

});


describe("follow-up context size", () => {
  it("keeps old messages out of resume deltas while retaining scoped human answers", () => {
    const message = (id: string, body: string) => ({
      id, body, authorType: "user", authorId: "board", createdAt: "2026-09-17T00:00:00Z",
      updatedAt: "2026-09-17T00:00:00Z", deleted: false, sourceTrust: null,
    });
    const oldBody = "PREVIOUS_TASK_TEXT ".repeat(1000);
    const newBody = "Actually, save the plan first.";
    const answerText = "No budget. Wait for my approval.";
    const continuation: ExecutionContinuationEnvelope = {
      version: 1, companyId: "company", issueId: "issue", objective: "Welcome",
      trigger: { reason: "issue_commented", interactionId: "answer-id", sourceRunId: null },
      originCommentIds: ["new"], messages: [message("old", oldBody), message("new", newBody)],
      resumeDelta: { baseRunId: "previous-run", messages: [message("new", newBody)] },
      humanResponses: [{ id: "answer-id", kind: "ask_user_questions", status: "answered",
        resolvedByUserId: "board", resolvedAt: "2026-09-17T00:01:00Z",
        result: { answers: [{ questionId: "scope", optionIds: [], otherText: answerText }] } }],
      interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: "new", summaryThroughCommentId: null },
    };
    const wake = { executionContinuation: continuation };
    const fresh = renderPaperclipWakePrompt(wake);
    const resumed = renderPaperclipWakePrompt(wake, { resumedSession: true });
    const contract = buildNativeCompletionContract({ title: "Welcome", description: oldBody }, {
      immediateRequest: newBody, humanResponseId: "answer-id",
    });
    expect(fresh).toContain(oldBody);
    expect(resumed).not.toContain("PREVIOUS_TASK_TEXT");
    expect(resumed.split(newBody)).toHaveLength(2);
    expect(resumed.split(answerText)).toHaveLength(2);
    expect(resumed).toContain("earlier history remains in this session");
    expect(JSON.stringify(contract)).not.toContain(oldBody);
    expect(JSON.stringify(contract)).not.toContain(answerText);
    expect(resumed.length + JSON.stringify(contract).length).toBeLessThan(fresh.length);
  });
});


describe("native completion references", () => {
  const source = nativeCompletionSource("description", "task", "Repeat. Repeat.");
  const args: Parameters<typeof buildNativeExecutionInput>[0] = {
    companyId: "company", runId: "run", agentId: "agent",
    issue: { id: "task", identifier: "PAP-1", title: "Brief", description: "Repeat. Repeat.", workMode: "standard" },
    taskPrompt: "Issue description:\nRepeat. Repeat.",
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: null,
    runtimeContext: nativeRuntimeContextFixture(),
    completionContract: {
      id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Brief", criteria: [{ id: "objective", requirement: "Repeat. Repeat." }] },
      sources: [{ id: "objective", source }],
    },
  };
  it("binds only source identities and revisions attested by the task renderer", () => {
    const input = buildNativeExecutionInput({ ...args, turnContext: {
      version: 1,
      assignment: { owner: "task_markdown", description: { id: source.id, revision: source.revision } },
      events: { owner: "wake_prompt", comments: [] },
    } });
    expect(input.completionSources).toMatchObject({ contractRevision: "1", criteria: [{ id: "objective", source }] });
    expect(input.completionContract.contract).toEqual(args.completionContract.contract);
    expect(input.task.description).toBe("Repeat. Repeat.");
  });
  it.each([
    undefined,
    { version: 1, assignment: { owner: "task_markdown", description: { id: "another-task", revision: source.revision } } },
    { version: 1, assignment: { owner: "task_markdown", description: { id: source.id, revision: "stale" } } },
  ])("keeps the full requirement when provenance is absent or stale", (turnContext) => {
    const input = buildNativeExecutionInput({ ...args, turnContext });
    expect(input.completionSources).toBeUndefined();
    expect(input.completionContract.contract).toEqual(args.completionContract.contract);
  });
});
