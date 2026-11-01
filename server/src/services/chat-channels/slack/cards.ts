import { cardToBlockKit } from "@chat-adapter/slack";
import type { AdapterPostableMessage, ActionEvent } from "chat";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";
import { Actions, Button, Card, CardText, LinkButton, type CardElement } from "chat";
import { isChatQuestionFormOpenActionId } from "../../chat-question-forms.js";

const MAX_CARD_BODY_LENGTH = 32_000;

export function slackInteractionRequiresBoard(body: string): boolean {
  return Array.from(body).length > MAX_CARD_BODY_LENGTH;
}

export function slackPublicationCard(payload: SafeChatPublicationPayload): CardElement | null {
  const card = payload.card;
  if (!card) return null;
  const children: CardElement["children"] = [];
  const body = Array.from((card.body ?? "").split("\n\n").filter(paragraph => paragraph.trim() !== card.title.trim()).join("\n\n"));
  const visibleBody = body.slice(0, MAX_CARD_BODY_LENGTH);
  for (let offset = 0; offset < visibleBody.length; offset += 2000) {
    children.push(CardText(visibleBody.slice(offset, offset + 2000).join("")));
  }
  if (body.length > MAX_CARD_BODY_LENGTH) children.push(CardText("This request is too long for Slack. Open it in Paperclip to read the complete request and respond."));
  const actions = (card.actions ?? []).map(action => {
    const label = Array.from(action.label).slice(0, 75).join("");
    return action.type === "callback"
      ? Button({ id: action.actionId, label, style: action.style ?? "default", value: payload.interactionId, actionType: isChatQuestionFormOpenActionId(action.actionId) ? "modal" : undefined })
      : LinkButton({ label, url: action.url });
  });
  if (actions.length) children.push(Actions(actions));
  const rendered = Card({ title: Array.from(card.title).slice(0, 150).join(""), children });
  if (!card.selection) return rendered;
  return Object.assign(rendered, { paperclipSelection: card.selection, paperclipInteractionId: payload.interactionId });
}

/** Slack-only wire rendering; the durable publication contains provider-neutral choices. */
export function slackSelectionMessage(message: AdapterPostableMessage) {
  if (typeof message !== "object" || !("card" in message)) return null;
  const card = message.card as CardElement & {
    paperclipSelection?: NonNullable<SafeChatPublicationPayload["card"]>["selection"];
    paperclipInteractionId?: string;
  };
  const selection = card.paperclipSelection;
  if (!selection || !card.paperclipInteractionId) return null;
  const options = selection.options.map(option => ({
    text: { type: "plain_text" as const, text: option.label },
    value: selection.multiple ? option.actionId : `${option.actionId}|${card.paperclipInteractionId}`,
    ...(option.description ? { description: { type: "plain_text" as const, text: option.description } } : {}),
  }));
  const blocks = cardToBlockKit(card);
  const initial_options = options.filter((_, index) => selection.options[index].selected);
  const initial = initial_options.length ? { initial_options } : {};
  const footer = blocks.filter(block => block.type === "actions");
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === "actions") blocks.splice(i, 1);
  if (selection.multiple) {
    blocks.push({ type: "actions", elements: [options.length <= 10
      ? { type: "checkboxes", action_id: `pcsv:${selection.actionId}`, options, ...initial }
      : { type: "multi_static_select", action_id: `pcsv:${selection.actionId}`, placeholder: { type: "plain_text", text: selection.label }, options, ...initial }] });
    blocks.push({ type: "actions", elements: [{ type: "button", action_id: selection.actionId, text: { type: "plain_text", text: selection.submitLabel ?? "Submit" }, value: card.paperclipInteractionId, style: "primary" }, ...footer.flatMap(block => block.type === "actions" ? block.elements : [])] });
  } else {
    blocks.push({ type: "actions", elements: [{ type: "static_select", action_id: selection.actionId, placeholder: { type: "plain_text", text: selection.label }, options, ...(initial_options[0] ? { initial_option: initial_options[0] } : {}) }] });
  }
  if (!selection.multiple) blocks.push(...footer);
  return { text: message.fallbackText ?? card.title ?? "Choose an answer", blocks };
}

/** URL buttons navigate in Slack; checkbox edits wait for an explicit submit. */
export function isPassiveSlackAction(event: Pick<ActionEvent, "actionId">): boolean {
  return event.actionId.startsWith("link-") || event.actionId.startsWith("pcsv:");
}

/** Convert the selected opaque token to the existing authorized button-answer path. */
export function normalizeSlackSelectionAction(event: ActionEvent): ActionEvent {
  if (!event.actionId.startsWith("pcs:")) return event;
  const [actionId, interactionId, extra] = (event.value ?? "").split("|");
  if (extra !== undefined || !actionId?.startsWith("pcq:") || event.actionId !== `pcs:${interactionId}`) return event;
  return { ...event, actionId, value: interactionId };
}


/** Selection changes stay client-side; only the explicit submit resolves work. */
export function slackSelectionValues(event: ActionEvent): string[] | undefined {
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  const values = record(record(record(event.raw)?.state)?.values);
  if (!values) return undefined;
  const fieldId = `pcsv:${event.actionId}`;
  const matches = Object.values(values).flatMap(block => {
    const field = record(record(block)?.[fieldId]);
    return field ? [field] : [];
  });
  if (matches.length !== 1) return undefined;
  const selected = matches[0].selected_options;
  if (!Array.isArray(selected) || selected.length > 100) return undefined;
  const tokens = selected.map(option => record(option)?.value);
  if (tokens.some(value => typeof value !== "string") || new Set(tokens).size !== tokens.length) return undefined;
  return tokens as string[];
}
