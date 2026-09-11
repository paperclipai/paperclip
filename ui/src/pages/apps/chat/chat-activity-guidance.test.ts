import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatActivityItem } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { chatActivityDetail } from "./chat-activity-guidance";

const authoredGuidance = [
  {
    "key": "slashUnconfirmedRetry",
    "kind": "action",
    "actionType": "slash_task_start",
    "detail": "Slack may have accepted the task-start message, so Paperclip will not replay it automatically. Check Slack first; an explicit retry can create a duplicate starter message and task."
  },
  {
    "key": "slashUnconfirmedLegacy",
    "kind": "action",
    "actionType": "slash_task_start",
    "detail": "Slack may have accepted the task-start message. This older action lacks the context required for a safe explicit retry, so check Slack and cancel it here before submitting a new command."
  },
  {
    "key": "slashConfirmed",
    "kind": "action",
    "actionType": "slash_task_start",
    "detail": "Slack accepted the task-start message. Paperclip is completing durable task admission without sending another Slack message."
  },
  {
    "key": "slashAdmitting",
    "kind": "action",
    "actionType": "slash_task_start",
    "detail": "Slack accepted the task-start message. A Paperclip worker is admitting the task without replaying the Slack send."
  },
  {
    "key": "slashRejected",
    "kind": "action",
    "actionType": "slash_task_start",
    "detail": "Slack rejected the task-start message. Submit the command again to retry."
  },
  {
    "key": "slashCancelled",
    "kind": "action",
    "actionType": "slash_task_start",
    "detail": "An operator cancelled this unconfirmed task start."
  },
  {
    "key": "replyUnconfirmedClose",
    "kind": "action",
    "actionType": "provider_effect",
    "detail": "The provider may have accepted this reply, but Paperclip could not confirm it or close the task conversation. Check the provider first. Marking it delivered closes the conversation; retrying can create a duplicate message."
  },
  {
    "key": "replyUnconfirmed",
    "kind": "action",
    "actionType": "provider_effect",
    "detail": "The provider may have accepted this reply, but Paperclip could not confirm it. Check the provider first. Retrying can create a duplicate message."
  },
  {
    "key": "sessionUnavailable",
    "kind": "action",
    "actionType": "slack_session_sync",
    "detail": "Slack has not enabled native session status for this destination. Message delivery continues."
  },
  {
    "key": "sessionRejected",
    "kind": "action",
    "actionType": "slack_session_sync",
    "detail": "Slack rejected the session indicator update. Check app permissions and channel access; message delivery is tracked separately."
  },
  {
    "key": "sessionWaiting",
    "kind": "action",
    "actionType": "slack_session_sync",
    "detail": "The Slack session indicator is waiting to sync. Paperclip will not resend the response."
  },
  {
    "key": "sessionWorking",
    "kind": "action",
    "actionType": "slack_session_sync",
    "detail": "Working status is refreshed automatically while the run remains active."
  },
  {
    "key": "stopProcessed",
    "kind": "action",
    "actionType": "slack_session_stop",
    "detail": "Paperclip stopped the work authorized by this request."
  },
  {
    "key": "stopCancelled",
    "kind": "action",
    "actionType": "slack_session_stop",
    "detail": "No work was stopped: this request was no longer authorized or its target was no longer current."
  },
  {
    "key": "stopRetry",
    "kind": "action",
    "actionType": "slack_session_stop",
    "detail": "The Stop request could not finish yet. Paperclip will retry against the original work only."
  },
  {
    "key": "stopFailed",
    "kind": "action",
    "actionType": "slack_session_stop",
    "detail": "The Stop request could not be completed. Check the task's current run before trying again."
  },
  {
    "key": "stopProcessing",
    "kind": "action",
    "actionType": "slack_session_stop",
    "detail": "Paperclip is processing this Stop request against its original task and run."
  },
  {
    "key": "githubIngress",
    "kind": "action",
    "actionType": "github_webhook_ingress",
    "detail": "An authenticated GitHub webhook could not be processed. Fix the connection or destination, then redeliver it from the GitHub App's Recent Deliveries page."
  },
  {
    "key": "recoverySourceChanged",
    "kind": "repair",
    "detail": "The original comment changed or is no longer available. Paperclip did not replay its old contents."
  },
  {
    "key": "recoveryIneligible",
    "kind": "repair",
    "detail": "This callback was not an eligible current user comment. Paperclip did not replay it."
  },
  {
    "key": "recoveryReceived",
    "kind": "repair",
    "detail": "Paperclip received this callback. Its normal access checks and processing still apply."
  },
  {
    "key": "recoveryRequested",
    "kind": "repair",
    "detail": "Paperclip asked GitHub to resend a recent missed message. This does not yet confirm receipt or a reply. Automatic requests are limited; if it remains unanswered, check the App's Recent Deliveries and send your request again in the current conversation."
  },
  {
    "key": "recoveryHistoryLimit",
    "kind": "health",
    "detail": "Recent webhook volume exceeded automatic recovery's bounded scan. No partial history was replayed. Check the App's Recent Deliveries for missed messages."
  },
  {
    "key": "recoveryCallbackMismatch",
    "kind": "health",
    "detail": "The GitHub App's callback no longer matches this connection. Reconnect the App to repair it; repository access will not change."
  },
  {
    "key": "recoveryScanFailed",
    "kind": "health",
    "detail": "Paperclip could not check GitHub's failed deliveries. The check will retry with backoff; normal callbacks are still processed."
  }
] as const;
const item = (overrides: Partial<ChatActivityItem>): ChatActivityItem => ({
  id: "raw-action-id", kind: "action", status: "failed", summary: "raw summary",
  createdAt: "2026-09-11T10:00:00Z", ...overrides,
});
afterEach(async () => { await i18n.changeLanguage("en"); });

describe("first-party chat activity guidance", () => {
  it("keeps the exact guidance fixtures aligned with the current listActivity source", () => {
    const service = readFileSync(new URL("../../../../../server/src/services/chat-channels.ts", import.meta.url), "utf8");
    const listActivity = service.slice(service.indexOf("async function listActivity("), service.indexOf("async function replayDelivery("));
    for (const fixture of authoredGuidance) expect(listActivity).toContain(JSON.stringify(fixture.detail));
  });

  it("updates all authored guidance EN → RU → EN without mutating the event", async () => {
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const { key, ...fixture } of authoredGuidance) {
        const event = item(fixture);
        const original = JSON.stringify(event);
        const rendered = chatActivityDetail(event);
        expect(rendered).toBe(i18n.t(`chatActivity.guidance.${key}`));
        expect(rendered).not.toContain("chatActivity.");
        if (locale === "en") expect(rendered).toBe(fixture.detail);
        else expect(rendered).toMatch(/[А-Яа-яЁё]/);
        expect(JSON.stringify(event)).toBe(original);
      }
    }
  });

  it("preserves the authenticated GitHub delivery identifier byte-for-byte", async () => {
    const deliveryId = "delivery-EXAMPLE_123-{{raw}}";
    const detail = `GitHub delivery ${deliveryId} was authenticated, but Paperclip could not finish processing it. Fix the connection or destination, then redeliver this delivery from the GitHub App's Recent Deliveries page.`;
    const event = item({ actionType: "github_webhook_ingress", detail });
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      const rendered = chatActivityDetail(event);
      expect(rendered).toContain(deliveryId);
      if (locale === "en") expect(rendered).toBe(detail);
      else expect(rendered).toMatch(/[А-Яа-яЁё]/);
      expect(event.detail).toBe(detail);
    }
  });

  it("does not translate provider lookalikes, mismatched action kinds, unknown text, or absent details", async () => {
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const fixture of authoredGuidance) {
        for (const kind of ["delivery", "publication"] as const) {
          const event = item({ kind, detail: fixture.detail });
          expect(chatActivityDetail(event)).toBe(fixture.detail);
        }
        const mismatched = item({ actionType: fixture.kind === "action" && fixture.actionType === "provider_effect" ? "slack_session_stop" : "provider_effect", detail: fixture.detail });
        expect(chatActivityDetail(mismatched)).toBe(fixture.detail);
        const modified = item({ ...fixture, detail: `${fixture.detail} Unknown provider suffix` });
        expect(chatActivityDetail(modified)).toBe(modified.detail);
      }
      for (const detail of ["Provider diagnostic DO_NOT_TRANSLATE", "", null, undefined]) {
        expect(chatActivityDetail(item({ actionType: "github_webhook_ingress", detail }))).toBe(detail);
      }
    }
  });
});
