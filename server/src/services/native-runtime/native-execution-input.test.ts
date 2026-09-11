import { describe, expect, it } from "vitest";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";

import { formatDurableQuestionResponseSummary } from "../question-response-delivery.js";
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
      expect(input.task.title).toBe("External chat follow-up");
      expect(input.task.prompt).toContain("Amber");
      expect(input.task.prompt).toContain(
        "semantic completion summary is the user-visible final answer",
      );
      expect(input.task.prompt).not.toContain(
        "including marking the task done",
      );
      expect(input.task.prompt).toContain("request_human_input");
      expect(input.task.prompt).toContain('interactionKind="questions"');
      expect(input.task.prompt).toContain("one question at a time");
      expect(input.task.prompt).toContain("Never fabricate answer URLs");
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
      expect(sequential.task.prompt).toContain("next unanswered question");
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
      expect(input.task.prompt).toContain("request_human_input");
      expect(input.task.prompt).toContain("Never fabricate answer URLs");
      expect(input.task.prompt).toContain("not a self-contained text answer");
      expect(input.task.prompt).toContain('continuationPolicy="wake_assignee"');
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
});
