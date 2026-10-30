import { describe, expect, it } from "vitest";
import { cardToBlockKit } from "@chat-adapter/slack";
import { projectSafeChatPublication } from "../../chat-publication-projection.js";
import { isPassiveSlackAction, normalizeSlackSelectionAction, slackPublicationCard, slackSelectionMessage, slackSelectionValues } from "./cards.js";

describe("Slack interaction card wire payloads", () => {
  it.each([120, 32000, 100000])("renders a %i-character request within Slack limits", length => {
    const payload = projectSafeChatPublication({
      classification: "external", source: "issue_interaction", text: "Read this request in Paperclip",
      interaction: { id: "interaction-1", card: {
        kind: "question", title: "😀".repeat(160), body: "Q".repeat(length),
        actions: [{ type: "link", label: "😀".repeat(80), url: "https://paperclip.example/issues/task-1" }],
      } },
    });
    const blocks = cardToBlockKit(slackPublicationCard(payload)!) as Array<{
      type: string;
      text?: { text: string };
      elements?: Array<{ text: { text: string } }>;
    }>;
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks[0]).toMatchObject({ type: "header", text: { text: "😀".repeat(150) } });
    for (const block of blocks) {
      if (block.type === "section") expect(Array.from(block.text!.text).length).toBeLessThanOrEqual(3000);
      if (block.type === "actions") expect(block.elements![0]).toMatchObject({ text: { text: "😀".repeat(75) } });
    }
    const wire = JSON.stringify(blocks);
    if (length > 32000) expect(wire).toContain("too long for Slack");
    else expect(blocks.filter(block => block.type === "section").map(block => block.text!.text).join("")).toBe("Q".repeat(length));
    expect(wire).toContain("https://paperclip.example/issues/task-1");
  });
});


describe("Slack inline selection", () => {
  it("renders searchable choices with opaque tokens and no repeated prompt", () => {
    const payload = projectSafeChatPublication({ classification: "external", source: "issue_interaction", text: "Choose a fixture", interaction: {
      id: "interaction-1", card: { kind: "question", title: "Which fixture?", body: "Which fixture?\n\nChoose one.", selection: {
        actionId: "pcs:interaction-1", label: "Choose a fixture", options: Array.from({ length: 13 }, (_, i) => ({ actionId: `pcq:option-${i}`, label: `Fixture ${i + 1}` })),
      } },
    } });
    const wire = slackSelectionMessage({ card: slackPublicationCard(payload)! });
    expect(wire?.blocks).toContainEqual(expect.objectContaining({ type: "actions", elements: [expect.objectContaining({ type: "static_select", options: expect.arrayContaining([expect.objectContaining({ value: "pcq:option-12|interaction-1", text: { type: "plain_text", text: "Fixture 13" } })]) })] }));
    expect(JSON.stringify(wire?.blocks).match(/Which fixture\?/g)).toHaveLength(1);
    const event = { actionId: "pcs:interaction-1", value: "pcq:option-12|interaction-1" } as Parameters<typeof normalizeSlackSelectionAction>[0];
    expect(normalizeSlackSelectionAction(event)).toMatchObject({ actionId: "pcq:option-12", value: "interaction-1" });
    const forged = { ...event, value: "pcq:option-12|other-interaction" };
    expect(normalizeSlackSelectionAction(forged)).toBe(forged);
  });
});


it("keeps multiple selections editable until explicit submit", () => {
  const payload = projectSafeChatPublication({ classification: "external", source: "issue_interaction", text: "Choose coverage", interaction: { id: "interaction-1", card: { kind: "question", title: "Coverage?", selection: { actionId: "pcq:submit", label: "Choose coverage", multiple: true, submitLabel: "Submit answer", options: [{ actionId: "pcq:legacy", label: "Legacy" }, { actionId: "pcq:native", label: "Native" }] } } } });
  const wire = slackSelectionMessage({ card: slackPublicationCard(payload)! });
  expect(wire?.blocks).toContainEqual({ type: "actions", elements: [{ type: "checkboxes", action_id: "pcsv:pcq:submit", options: [{ text: { type: "plain_text", text: "Legacy" }, value: "pcq:legacy" }, { text: { type: "plain_text", text: "Native" }, value: "pcq:native" }] }] });
  expect(wire?.blocks.at(-1)).toMatchObject({ elements: [{ type: "button", action_id: "pcq:submit", value: "interaction-1" }] });
  const event = { actionId: "pcq:submit", raw: { state: { values: { block: { "pcsv:pcq:submit": { selected_options: [{ value: "pcq:legacy" }, { value: "pcq:native" }] } } } } } } as Parameters<typeof slackSelectionValues>[0];
  expect(slackSelectionValues(event)).toEqual(["pcq:legacy", "pcq:native"]);
  expect(slackSelectionValues({ ...event, actionId: "pcq:unrelated" })).toBeUndefined();
});


describe("untrusted Slack selection state", () => {
  const event = (raw: unknown) => ({ actionId: "pcq:submit", raw } as Parameters<typeof slackSelectionValues>[0]);
  it.each([null, [], { state: null }, { state: { values: { block: null } } },
    { state: { values: { block: { "pcsv:pcq:submit": { selected_options: [null] } } } } },
    { state: { values: { block: { "pcsv:pcq:submit": { selected_options: [{ value: "x" }, { value: "x" }] } } } } },
  ])("rejects malformed or duplicate selections without throwing: %j", raw => {
    expect(slackSelectionValues(event(raw))).toBeUndefined();
  });
  it("does not choose between ambiguous state blocks", () => {
    const field = { "pcsv:pcq:submit": { selected_options: [{ value: "x" }] } };
    expect(slackSelectionValues(event({ state: { values: { one: field, two: field } } }))).toBeUndefined();
  });
  it("preserves an explicit empty selection", () => {
    expect(slackSelectionValues(event({ state: { values: { one: { "pcsv:pcq:submit": { selected_options: [] } } } } }))).toEqual([]);
  });
});

it("acknowledges rendered link buttons without treating navigation as an answer", () => {
  const payload = projectSafeChatPublication({ classification: "external", source: "issue_interaction", text: "Review GitHub", interaction: { id: "interaction-1", card: { kind: "question", title: "Connect GitHub", actions: [{ type: "link", label: "Review connection", url: "https://paperclip.example/issues/task-1" }, { type: "callback", label: "Not now", actionId: "pcq:decline" }] } } });
  const blocks = cardToBlockKit(slackPublicationCard(payload)!);
  const actions = blocks.flatMap(block => block.type === "actions" ? block.elements : []);
  const link = actions.find((action): action is { url: string; action_id: string } =>
    typeof action === "object" && action !== null && "url" in action && "action_id" in action
    && typeof action.url === "string" && typeof action.action_id === "string");
  expect(link).toMatchObject({ type: "button", url: "https://paperclip.example/issues/task-1" });
  expect(isPassiveSlackAction({ actionId: link!.action_id! })).toBe(true);
  expect(isPassiveSlackAction({ actionId: "pcsv:pcq:submit" })).toBe(true);
  expect(isPassiveSlackAction({ actionId: "pcq:decline" })).toBe(false);
});
