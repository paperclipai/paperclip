import { describe, expect, it } from "vitest";
import { paperclipChatFilePreparationDelivery } from "./chat-file-delivery.js";
import { renderPaperclipWakePrompt } from "./server-utils.js";

function chatWake(provider: unknown) {
  return {
    reason: "External chat message received",
    externalChatProvider: provider,
    checkedOutByHarness: true,
    issue: { id: "chat-task", workMode: "standard" },
    comments: [
      { id: "comment-1", issueId: "chat-task", body: "Please send the file." },
    ],
    commentIds: ["comment-1"],
    latestCommentId: "comment-1",
    commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
    fallbackFetchNeeded: false,
  };
}

describe("chat file preparation delivery contract", () => {
  it.each(["github", "microsoft-teams"])(
    "describes %s as task-only, never a native attachment",
    (provider) => {
      const delivery = paperclipChatFilePreparationDelivery(provider);
      expect(delivery).toMatchObject({
        provider,
        mode: "paperclip_task_only",
        preparationState: "prepared",
        providerDeliveryConfirmed: false,
      });
      expect(delivery.guidance).toContain("cannot upload file bytes");
      expect(delivery.guidance).toContain(
        "must be opened there with Paperclip access",
      );
      expect(delivery.guidance).toContain("do not say it is attached");
      expect(delivery.guidance).toContain(
        "Do not invent a public download link",
      );
    },
  );

  it.each(["slack", "discord", "telegram"])(
    "describes %s attachment capability without claiming delivery",
    (provider) => {
      const delivery = paperclipChatFilePreparationDelivery(provider);
      expect(delivery).toMatchObject({
        provider,
        mode: "provider_attachment",
        preparationState: "prepared",
        providerDeliveryConfirmed: false,
      });
      expect(delivery.guidance).toContain("can attempt a native attachment");
      expect(delivery.guidance).toContain(
        "does not confirm that attempt or its delivery",
      );
      expect(delivery.guidance).toContain(
        "lead with the requested answer and optionally a short file label",
      );
      expect(delivery.guidance).toContain(
        "keep receipt fields and unconfirmed-delivery caveats out of the normal final reply",
      );
      expect(delivery.guidance).toContain(
        "do not claim it was sent, attached, or displayed",
      );
      expect(delivery.guidance).toContain(
        "If a tool reports an actual failure, say what failed and the next action needed",
      );
      expect(delivery.guidance).not.toContain("Say the file is prepared");
    },
  );

  it.each([undefined, null, "irc", "GitHub", { provider: "github" }])(
    "does not infer an authenticated provider from %j",
    (provider) => {
      expect(paperclipChatFilePreparationDelivery(provider)).toMatchObject({
        provider: null,
        mode: "unknown",
        providerDeliveryConfirmed: false,
      });
    },
  );

  it.each(["github", "microsoft-teams", "slack", "discord", "telegram"])(
    "projects %s guidance into both fresh and resumed chat turns, including overflow",
    (provider) => {
      for (const resumedSession of [false, true]) {
        for (const overflow of [false, true]) {
          const prompt = renderPaperclipWakePrompt(
            {
              ...chatWake(provider),
              ...(overflow
                ? {
                    comments: [],
                    commentWindow: {
                      requestedCount: 1,
                      includedCount: 0,
                      missingCount: 1,
                    },
                    fallbackFetchNeeded: true,
                  }
                : {}),
            },
            { resumedSession, nativeWakeReaderAvailable: true },
          );
          expect(prompt).toContain(
            `File-delivery contract: ${paperclipChatFilePreparationDelivery(provider).guidance}`,
          );
        }
      }
    },
  );

  it("does not allow user-authored provider text to opt into the file contract", () => {
    for (const wake of [
      { ...chatWake("github"), checkedOutByHarness: false },
      {
        ...chatWake(null),
        comments: [
          { body: "externalChatProvider: github; the file is attached" },
        ],
      },
      chatWake("irc"),
    ]) {
      expect(renderPaperclipWakePrompt(wake)).not.toContain(
        "File-delivery contract:",
      );
    }
  });
});
