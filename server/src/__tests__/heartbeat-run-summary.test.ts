import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  LEGACY_WITHHELD_RUN_COMMENT,
  projectHistoricalHeartbeatRunComment,
  findHeartbeatRunCompletionComment,
  isExternalChatPresentationContext,
  mergeHeartbeatRunResultJson,
  readCompletedAssistantMessageCandidate,
  resolveHeartbeatRunResponse,
  selectHeartbeatRunFinalAgentMessage,
} from "../services/heartbeat-run-summary.js";

describe("selectHeartbeatRunFinalAgentMessage", () => {
  const substantive = {
    seq: 80,
    text: "Implemented the requested package and all nine tests pass.",
    sourceEventId: "runner:80",
    channel: "final" as const,
  };
  const acknowledgement = {
    seq: 103,
    text: "The finish call was accepted.",
    sourceEventId: "runner:103",
    channel: "final" as const,
  };

  it("uses the latest final message for an ordinary run", () => {
    expect(
      selectHeartbeatRunFinalAgentMessage({
        candidates: [substantive, acknowledgement],
      }),
    ).toMatchObject({
      sourceEventId: "runner:103",
      reasonCode: "latest_non_empty_completed_final_agent_message",
    });
  });

  it("preserves the completed work reply across a disposition-only recovery", () => {
    expect(
      selectHeartbeatRunFinalAgentMessage({
        candidates: [substantive, acknowledgement],
        semanticResultRecoveryAfterSeq: 82,
      }),
    ).toMatchObject({
      sourceEventId: "runner:80",
      reasonCode: "pre_semantic_result_recovery_final_agent_message",
    });
  });

  it("prefers an explicit final over a newer unknown-channel assistant message", () => {
    expect(
      selectHeartbeatRunFinalAgentMessage({
        candidates: [
          substantive,
          {
            seq: 120,
            text: "Terminal assistant compatibility response.",
            sourceEventId: "runner:120",
            channel: "unknown",
          },
        ],
      }),
    ).toMatchObject({
      sourceEventId: "runner:80",
      channel: "final",
      reasonCode: "latest_non_empty_completed_final_agent_message",
    });
  });

  it("falls back to the latest completed unknown-channel assistant message", () => {
    expect(
      selectHeartbeatRunFinalAgentMessage({
        candidates: [
          {
            seq: 120,
            text: "Terminal assistant compatibility response.",
            sourceEventId: "runner:120",
            channel: "unknown",
          },
        ],
      }),
    ).toMatchObject({
      sourceEventId: "runner:120",
      channel: "unknown",
      reasonCode: "latest_non_empty_completed_terminal_assistant_message",
    });
  });
});

describe("readCompletedAssistantMessageCandidate", () => {
  it.each(["final", "unknown"] as const)(
    "accepts completed %s-channel assistant messages",
    (channel) => {
      expect(
        readCompletedAssistantMessageCandidate({
          seq: 17,
          prpEvent: {
            sourceEventId: `runner:${channel}`,
            payload: {
              kind: "agentMessage",
              channel,
              text: `response-${channel}`,
            },
          },
        }),
      ).toEqual({
        seq: 17,
        sourceEventId: `runner:${channel}`,
        channel,
        text: `response-${channel}`,
      });
    },
  );

  it("keeps the persisted PRP v1 assistant_message alias readable", () => {
    expect(
      readCompletedAssistantMessageCandidate({
        seq: 18,
        prpEvent: {
          sourceEventId: "runner:legacy-final",
          payload: {
            kind: "assistant_message",
            channel: "final",
            text: "Persisted final response.",
          },
        },
      }),
    ).toEqual({
      seq: 18,
      sourceEventId: "runner:legacy-final",
      channel: "final",
      text: "Persisted final response.",
    });
  });

  it("rejects progress and non-assistant completed items", () => {
    expect(
      readCompletedAssistantMessageCandidate({
        seq: 18,
        prpEvent: {
          payload: {
            kind: "agentMessage",
            channel: "progress",
            text: "still working",
          },
        },
      }),
    ).toBeNull();
    expect(
      readCompletedAssistantMessageCandidate({
        seq: 19,
        prpEvent: {
          payload: {
            kind: "toolResult",
            channel: "unknown",
            text: "tool output",
          },
        },
      }),
    ).toBeNull();
  });
});

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(
      summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<
        string,
        unknown
      >),
    ).toBeNull();
    expect(
      summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } }),
    ).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe(
      "completed",
    );
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });

  it("suppresses raw transcript when the summary reads like inter-tool narration", () => {
    const narration =
      "Let me check the issue thread first. I'll fetch the latest comments and then decide what to do next.";
    const comment = buildHeartbeatRunIssueComment({ summary: narration });

    expect(comment).toBeNull();
  });

  it("suppresses each narration opener variant", () => {
    for (const opener of [
      "Let me look into this.",
      "I'll start by reading the file.",
      "I need to inspect the config.",
      "I can see the problem now.",
      "Looking at the logs, the error is clear.",
      "Fetching the run details from the API.",
      "Checking the current branch state.",
      "First, I will reproduce the bug.",
      "I’m going to trace the fallback path.",
      "Now I'll push the follow-up commit.",
      "Next, I'll re-run the suite.",
    ]) {
      expect(buildHeartbeatRunIssueComment({ summary: opener })).toBeNull();
    }
  });

  it("does not treat the apostrophe opener as a regex wildcard", () => {
    // Prior regex used `i.ll` where `.` matched any char; these must pass through.
    for (const summary of ["Iall greetings logged.", "I-ll formatting kept."]) {
      expect(buildHeartbeatRunIssueComment({ summary })).toBe(summary);
    }
  });

  it("never suppresses a response because of its length", () => {
    const summary = "x".repeat(20_000);
    expect(buildHeartbeatRunIssueComment({ summary })).toBe(summary);
  });

  it("posts a clean, in-length summary with no narration opener normally", () => {
    const summary =
      "## Summary\n\n- fixed the fallback gate\n- added regression tests";
    expect(buildHeartbeatRunIssueComment({ summary })).toBe(summary);
  });

  it("uses an accepted semantic result even when it resembles narration", () => {
    const summary =
      "Let me give you the complete recipe now.\n\n" + "x".repeat(1_420);
    expect(
      buildHeartbeatRunIssueComment({
        summary: "",
        nativeResult: {
          schema: "paperclip.run_result.v1",
          reportedWorkDisposition: "done",
          summary,
        },
      }),
    ).toBe(summary);
  });
});

describe("resolveHeartbeatRunResponse", () => {
  const resultJson = {
    nativeResult: {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "done",
      summary: "semantic result",
    },
  };

  it("applies comment, explicit provider, adapter, terminal fallback, and semantic precedence", () => {
    const resultWithAdapterFinal = {
      ...resultJson,
      finalResponse: {
        disposition: "final",
        text: "adapter response",
      },
    };
    expect(
      resolveHeartbeatRunResponse({
        resultJson: resultWithAdapterFinal,
        existingComment: { id: "comment-1", body: "posted response" },
        finalAgentMessage: {
          text: "provider response",
          sourceEventId: "event-1",
          channel: "final",
        },
      }),
    ).toMatchObject({
      text: "posted response",
      decision: {
        chosenSource: "existing_issue_comment",
        commentAction: "reuse",
        commentId: "comment-1",
      },
    });

    expect(
      resolveHeartbeatRunResponse({
        resultJson: resultWithAdapterFinal,
        finalAgentMessage: {
          text: "provider response",
          sourceEventId: "event-1",
          channel: "final",
        },
      }),
    ).toMatchObject({
      text: "provider response",
      decision: {
        chosenSource: "final_agent_message",
        sourceEventId: "event-1",
      },
    });

    expect(
      resolveHeartbeatRunResponse({
        resultJson: resultWithAdapterFinal,
        finalAgentMessage: {
          text: "compatible terminal response",
          sourceEventId: "event-unknown",
          channel: "unknown",
        },
      }),
    ).toMatchObject({
      text: "adapter response",
      decision: { chosenSource: "adapter_final_response" },
    });

    expect(
      resolveHeartbeatRunResponse({
        resultJson,
        finalAgentMessage: {
          text: "compatible terminal response",
          sourceEventId: "event-unknown",
          channel: "unknown",
        },
      }),
    ).toMatchObject({
      text: "compatible terminal response",
      decision: {
        chosenSource: "final_agent_message",
        sourceEventId: "event-unknown",
      },
    });

    expect(resolveHeartbeatRunResponse({ resultJson })).toMatchObject({
      text: "semantic result",
      decision: { chosenSource: "semantic_result_summary" },
    });
  });

  it("returns no response instead of an artificial placeholder", () => {
    expect(resolveHeartbeatRunResponse({ resultJson: null })).toMatchObject({
      text: null,
      decision: { chosenSource: "none", commentAction: "none" },
    });
  });

  it("keeps a yielded control-plane wait out of the assistant conversation", () => {
    expect(
      resolveHeartbeatRunResponse({
        resultJson: {
          nativeResult: {
            schema: "paperclip.run_result.v1",
            reportedWorkDisposition: "yielded",
            summary: "Waiting for Choose an output format.",
          },
        },
      }),
    ).toMatchObject({
      text: null,
      decision: { chosenSource: "none", commentAction: "none" },
    });

    expect(
      resolveHeartbeatRunResponse({
        resultJson: {
          summary: "Waiting for Choose an output format.",
          nativeResult: {
            schema: "paperclip.run_result.v1",
            reportedWorkDisposition: "yielded",
            summary: "Waiting for Choose an output format.",
          },
        },
      }),
    ).toMatchObject({
      text: null,
      decision: {
        chosenSource: "none",
        commentAction: "none",
        reasonCodes: ["yielded_control_plane_wait"],
      },
    });

    expect(
      resolveHeartbeatRunResponse({
        resultJson: {
          nativeResult: {
            schema: "paperclip.run_result.v1",
            reportedWorkDisposition: "yielded",
            summary: "Waiting for Choose an output format.",
          },
        },
        finalAgentMessage: {
          text: "Choose an output format before I continue.",
          sourceEventId: "event-waiting-final",
          channel: "final",
        },
      }),
    ).toMatchObject({
      text: null,
      decision: {
        chosenSource: "none",
        reasonCodes: ["yielded_control_plane_wait"],
      },
    });
  });

  it("does not render a serialized semantic result as the final prose", () => {
    expect(
      resolveHeartbeatRunResponse({
        resultJson,
        finalAgentMessage: {
          text: JSON.stringify(resultJson.nativeResult),
          sourceEventId: "event-structured-result",
          channel: "final",
        },
      }),
    ).toMatchObject({
      text: "semantic result",
      decision: { chosenSource: "semantic_result_summary" },
    });
  });

  it("does not let an empty issue comment hide an upstream response", () => {
    expect(
      resolveHeartbeatRunResponse({
        resultJson,
        existingComment: { id: "empty-comment", body: "  " },
      }),
    ).toMatchObject({
      text: "semantic result",
      decision: { chosenSource: "semantic_result_summary" },
    });
  });

  it("preserves the exact upstream response text", () => {
    const text = "\n  final response with intentional whitespace  \n";
    expect(
      resolveHeartbeatRunResponse({
        resultJson,
        finalAgentMessage: {
          text,
          sourceEventId: "event-exact",
          channel: "final",
        },
      }).text,
    ).toBe(text);
  });

  it("prefers the exact completed final over a bookkeeping comment for external chat", () => {
    const resolved = resolveHeartbeatRunResponse({
      resultJson,
      existingComment: {
        id: "lifecycle-comment",
        body: "Answer received. Closing issue.",
      },
      finalAgentMessage: {
        text: "TELEGRAM-LIFECYCLE5-Onyx",
        sourceEventId: "event-continuation-final",
        channel: "final",
      },
      preferFinalResponseOverExistingComment: true,
    });

    expect(resolved).toMatchObject({
      text: "TELEGRAM-LIFECYCLE5-Onyx",
      decision: {
        chosenSource: "final_agent_message",
        sourceEventId: "event-continuation-final",
        commentAction: "create",
        commentId: null,
        reasonCodes: expect.arrayContaining(["external_chat_final_precedence"]),
      },
    });
  });

  it("prefers an accepted adapter result over a lifecycle comment for an external-chat continuation", () => {
    expect(
      resolveHeartbeatRunResponse({
        resultJson: {
          acceptedResult: {
            schema: "paperclip.run_result.v1",
            reportedWorkDisposition: "done",
            summary: "TELEGRAM-ACCEPTED-Onyx",
          },
        },
        existingComment: {
          id: "lifecycle-comment",
          body: "Answer received. Closing issue.",
        },
        preferFinalResponseOverExistingComment: true,
      }),
    ).toMatchObject({
      text: "TELEGRAM-ACCEPTED-Onyx",
      decision: {
        chosenSource: "semantic_result_summary",
        commentAction: "create",
        commentId: null,
        reasonCodes: expect.arrayContaining(["external_chat_final_precedence"]),
      },
    });
  });

  it("prefers a legacy adapter final over an earlier root-chat acknowledgement", () => {
    expect(
      resolveHeartbeatRunResponse({
        resultJson: { summary: "GITHUB-LIVE-FINAL-MARKER" },
        existingComment: {
          id: "acknowledgement-comment",
          body: "Acknowledged the latest comment; it changes my next action.",
        },
        preferFinalResponseOverExistingComment: true,
      }),
    ).toMatchObject({
      text: "GITHUB-LIVE-FINAL-MARKER",
      decision: {
        chosenSource: "adapter_final_response",
        commentAction: "create",
        commentId: null,
        reasonCodes: [
          "legacy_adapter_summary_compatibility",
          "external_chat_final_precedence",
        ],
      },
    });
  });

  it("withholds a root-chat acknowledgement when no completed final is available", () => {
    expect(
      resolveHeartbeatRunResponse({
        resultJson: {},
        existingComment: {
          id: "acknowledgement-comment",
          body: "Acknowledged; I am starting the requested work.",
        },
        preferFinalResponseOverExistingComment: true,
      }),
    ).toMatchObject({
      text: null,
      decision: {
        chosenSource: "none",
        commentAction: "none",
        commentId: null,
        reasonCodes: ["external_chat_final_response_unavailable"],
      },
    });
  });

  it("withholds root-chat bookkeeping while a governed interaction owns output", () => {
    expect(
      resolveHeartbeatRunResponse({
        resultJson: {
          nativeResult: {
            schema: "paperclip.run_result.v1",
            reportedWorkDisposition: "yielded",
            summary: "Waiting for a provider answer.",
          },
        },
        existingComment: {
          id: "acknowledgement-comment",
          body: "I created the question and am waiting.",
        },
        preferFinalResponseOverExistingComment: true,
      }),
    ).toMatchObject({
      text: null,
      decision: {
        chosenSource: "none",
        commentAction: "none",
        reasonCodes: ["yielded_control_plane_wait"],
      },
    });
  });

  it("publishes only an authorized committed external response-wake summary", () => {
    const responseWakeResult = {
      finalizationPhase: "committed",
      finalizationReasonCode: "external_chat_response_waiting",
      nativeResult: {
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "yielded",
        summary: "SLACK-LUNA-WAITING",
        continuation: {
          kind: "response_wake",
          summary: "Wait for the next external reply.",
          idempotencyKey: "response-wake-slack-1",
        },
      },
    };
    const resolve = (
      resultJson: Record<string, unknown>,
      authorized: boolean,
    ) =>
      resolveHeartbeatRunResponse({
        resultJson,
        preferFinalResponseOverExistingComment: true,
        externalChatResponseWakeSummaryAuthorized: authorized,
        finalAgentMessage: {
          text: "Internal narration must not become the provider reply.",
          sourceEventId: "event-response-wake",
          channel: "final",
        },
      });

    expect(resolve(responseWakeResult, true)).toMatchObject({
      text: "SLACK-LUNA-WAITING",
      decision: {
        chosenSource: "semantic_result_summary",
        commentAction: "create",
        reasonCodes: [
          "accepted_external_chat_response_wake_summary",
          "external_chat_final_precedence",
        ],
      },
    });
    expect(resolve(responseWakeResult, false)).toMatchObject({
      text: null,
      decision: {
        chosenSource: "none",
        reasonCodes: ["yielded_control_plane_wait"],
      },
    });
    for (const resultJson of [
      { ...responseWakeResult, finalizationPhase: "retryable_failure" },
      {
        ...responseWakeResult,
        finalizationReasonCode: "governed_response_waiting",
      },
      {
        ...responseWakeResult,
        nativeResult: {
          ...responseWakeResult.nativeResult,
          continuation: {
            ...responseWakeResult.nativeResult.continuation,
            kind: "same_agent",
          },
        },
      },
      {
        ...responseWakeResult,
        nativeResult: {
          ...responseWakeResult.nativeResult,
          continuation: {
            kind: "response_wake",
            summary: "Wait for the next external reply.",
          },
        },
      },
    ]) {
      expect(resolve(resultJson, true)).toMatchObject({
        text: null,
        decision: {
          chosenSource: "none",
          reasonCodes: ["yielded_control_plane_wait"],
        },
      });
    }
  });

  it("requires separate server authority to present a committed response after a preserved task status", () => {
    const resultJson = {
      finalizationPhase: "committed",
      finalizationReasonCode: "prior_status_terminal_preserved",
      externalChatCommittedResponseWakeSummaryAuthorized: true,
      nativeResult: {
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "yielded",
        summary: "Exact accepted public response",
        continuation: {
          kind: "response_wake",
          summary: "Wait for the next reply",
          idempotencyKey: "same-response",
        },
      },
      finalResponse: { final: true, text: "PRIVATE provider narration" },
    };
    const resolve = (authority: boolean, value = resultJson) =>
      resolveHeartbeatRunResponse({
        resultJson: value,
        preferFinalResponseOverExistingComment: true,
        externalChatResponseWakeSummaryAuthorized: true,
        externalChatCommittedResponseWakeSummaryAuthorized: authority,
      });
    expect(resolve(false).text).toBeNull();
    expect(resolve(true).text).toBe("Exact accepted public response");
    expect(
      resolve(true, { ...resultJson, finalizationPhase: "retryable_failure" })
        .text,
    ).toBeNull();
    expect(
      resolve(true, {
        ...resultJson,
        nativeResult: {
          ...resultJson.nativeResult,
          continuation: {
            ...resultJson.nativeResult.continuation,
            kind: "interaction",
          },
        },
      }).text,
    ).toBeNull();
    expect(resolve(true).decision.chosenSource).toBe("semantic_result_summary");
  });

  it("keeps ordinary comment precedence unchanged", () => {
    expect(
      resolveHeartbeatRunResponse({
        resultJson,
        existingComment: {
          id: "ordinary-comment",
          body: "Ordinary explicit comment",
        },
        finalAgentMessage: {
          text: "Ordinary adapter final",
          sourceEventId: "event-ordinary-final",
          channel: "final",
        },
      }),
    ).toMatchObject({
      text: "Ordinary explicit comment",
      decision: {
        chosenSource: "existing_issue_comment",
        commentAction: "reuse",
        commentId: "ordinary-comment",
        reasonCodes: ["explicit_non_progress_comment_precedence"],
      },
    });
  });

  it("requires separate server review-presentation authorization for a governed response wait", () => {
    const resultJson = {
      finalizationPhase: "committed",
      finalizationReasonCode: "governed_response_waiting",
      externalChatReviewPresentation: {
        schema: "paperclip.chat_review_response_presentation.v1",
      },
      nativeResult: {
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "yielded",
        summary:
          "The original image is prepared for delivery; the completion review is still pending.",
        continuation: {
          kind: "response_wake",
          summary: "Wait for the next authorized message",
          idempotencyKey: "review-wait",
        },
      },
    };
    const resolve = (
      reviewAuthorized: boolean,
      bound = true,
      result = resultJson,
    ) =>
      resolveHeartbeatRunResponse({
        resultJson: result,
        preferFinalResponseOverExistingComment: true,
        externalChatResponseWakeSummaryAuthorized: bound,
        externalChatReviewResponseSummaryAuthorized: reviewAuthorized,
        finalAgentMessage: {
          text: "Never publish this raw narration or review payload",
          channel: "final",
          sourceEventId: "raw",
        },
      });
    expect(resolve(true)).toMatchObject({
      text: resultJson.nativeResult.summary,
      decision: {
        chosenSource: "semantic_result_summary",
        commentAction: "create",
      },
    });
    expect(resolve(false).text).toBeNull();
    expect(resolve(true, false).text).toBeNull();
    expect(
      resolve(true, true, {
        ...resultJson,
        finalizationPhase: "retryable_failure",
      }).text,
    ).toBeNull();
    expect(
      resolve(true, true, {
        ...resultJson,
        nativeResult: {
          ...resultJson.nativeResult,
          continuation: {
            ...resultJson.nativeResult.continuation,
            kind: "same_agent",
          },
        },
      }).text,
    ).toBeNull();
  });

  it("recognizes root and continuation external-chat presentation contexts", () => {
    expect(
      isExternalChatPresentationContext({
        source: "chat:github",
      }),
    ).toBe(true);
    expect(
      isExternalChatPresentationContext({
        externalChatContinuation: true,
      }),
    ).toBe(true);
    expect(
      isExternalChatPresentationContext({
        paperclipWake: { externalInteractionContinuation: true },
      }),
    ).toBe(true);
    expect(
      isExternalChatPresentationContext({
        externalChatContinuation: false,
        paperclipWake: { externalInteractionContinuation: false },
      }),
    ).toBe(false);
    expect(isExternalChatPresentationContext({ source: "chatty:github" })).toBe(
      false,
    );
    expect(isExternalChatPresentationContext(null)).toBe(false);
  });
});

describe("projectHistoricalHeartbeatRunComment", () => {
  it("projects the accepted semantic response over the known placeholder", () => {
    const summary = "# Full recipe\n\n" + "ribs ".repeat(400);
    expect(
      projectHistoricalHeartbeatRunComment(LEGACY_WITHHELD_RUN_COMMENT, {
        nativeResult: {
          schema: "paperclip.run_result.v1",
          summary,
        },
      }),
    ).toBe(summary);
  });

  it("does not rewrite ordinary historical comments", () => {
    expect(
      projectHistoricalHeartbeatRunComment("Real response", {
        nativeResult: {
          schema: "paperclip.run_result.v1",
          summary: "Different response",
        },
      }),
    ).toBe("Real response");
  });
});

describe("findHeartbeatRunCompletionComment", () => {
  it("does not let semantic progress satisfy the final comment", () => {
    const progress = { id: "progress-comment" };
    const final = { id: "final-comment" };
    const resultJson = {
      semanticToolReceipts: {
        progress: {
          operationId: "report_progress",
          result: { commentId: progress.id },
        },
      },
    };

    expect(
      findHeartbeatRunCompletionComment([progress], resultJson),
    ).toBeNull();
    expect(
      findHeartbeatRunCompletionComment([final, progress], resultJson),
    ).toEqual(final);
  });

  it("preserves the fallback-only behavior for ordinary agent comments", () => {
    const comment = { id: "manual-comment" };
    expect(
      findHeartbeatRunCompletionComment([comment], { summary: "done" }),
    ).toEqual(comment);
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe(
      "## Summary\n\n1. first thing\n2. second thing",
    );
  });

  it("posts only the final adapter summary when raw output contains intermediate narration", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "Intermediate setup that must not be published" },
      "## Final update\n\n- Remediation verified",
    );

    expect(buildHeartbeatRunIssueComment(merged)).toBe(
      "## Final update\n\n- Remediation verified",
    );
    expect(buildHeartbeatRunIssueComment(merged)).not.toContain(
      "Intermediate setup",
    );
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({
      summary: "done",
    });
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });
});
