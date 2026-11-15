import { createHash } from "node:crypto";
import type { ModalElement } from "chat";
import { slackDeferredCallbackActive } from "./cloud-callback.js";
import { slackFormOpenContext } from "./cloud-forms.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import { SlackAdapter } from "@chat-adapter/slack";
import type { AdapterPostableMessage, LinkPreview, RawMessage } from "chat";
import { slackSelectionMessage } from "./cards.js";

export class PaperclipSlackAdapter extends SlackAdapter {
  override async openModal(triggerId: string, modal: ModalElement, contextId?: string): Promise<{ viewId: string }> {
    const current = slackFormOpenContext();
    if (!current) {
      if (slackDeferredCallbackActive()) throw new SlackCloudReceiptError("callback_trigger_owner_required", "attention");
      return super.openModal(triggerId, modal, contextId);
    }
    const view = current.operation.view;
    if (!view || current.operation.closed || current.updateAttempted || createHash("sha256").update(triggerId).digest("hex") !== current.operation.triggerDigest)
      throw new SlackCloudReceiptError("form_provider_attempt_changed", "attention");
    current.updateAttempted = true;
    const result = await super.updateModal(view.id, { ...modal, notifyOnClose: true }, { hash: view.hash, externalId: view.externalId, contextId });
    if (result.viewId !== view.id || !result.viewHash) throw new SlackCloudReceiptError("form_update_receipt_invalid", "attention");
    current.updatedView = { ...view, hash: result.viewHash };
    return { viewId: result.viewId };
  }

  override async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage> {
    const payload = slackSelectionMessage(message);
    if (!payload) return super.postMessage(threadId, message);
    const { channel, threadTs } = this.decodeThreadId(threadId);
    try {
      const result = await this._client.chat.postMessage(await this.withToken({ channel, thread_ts: threadTs || undefined, ...payload, unfurl_links: false, unfurl_media: false }));
      if (!result.ts) throw new Error("Slack did not return a message receipt");
      return { id: result.ts, threadId, raw: result };
    } catch (error) { this.handleSlackError(error); }
  }

  override async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage): Promise<RawMessage> {
    const payload = slackSelectionMessage(message);
    if (!payload) return super.editMessage(threadId, messageId, message);
    const { channel } = this.decodeThreadId(threadId);
    try {
      const result = await this._client.chat.update(await this.withToken({ channel, ts: messageId, ...payload }));
      if (!result.ts) throw new Error("Slack did not return an edit receipt");
      return { id: result.ts, threadId, raw: result };
    } catch (error) { this.handleSlackError(error); }
  }

  // The SDK polls for an optional Slack unfurl for two seconds before it
  // delivers a message containing a URL. Paperclip accepts the message text,
  // links and files directly; preview metadata is not part of task admission.
  protected override async enrichLinks(links: LinkPreview[]): Promise<LinkPreview[]> {
    return links;
  }
}
