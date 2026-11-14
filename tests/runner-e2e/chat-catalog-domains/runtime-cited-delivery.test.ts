import { expect, it } from "vitest";
import { continuationCarriesOwed, owedAfterTurn } from "./runtime-cited-delivery.js";

const font = { id: "3b2395dc-11b1-43dd-95ff-56c2fcdfb5bd", updatedAt: "2026-11-13T04:01:28.647Z", body: "Use a readable font." };
const contact = { id: "3aa8c723-5c96-4346-85a8-a4992694307e", updatedAt: "2026-11-13T04:03:45.909Z", body: "Add a contact section.\nLabel it." };
const read = { [font.id]: font.updatedAt, [contact.id]: contact.updatedAt };
const wake = (ids: string[], earlier: string[] = []) => ({ wakeCommentIds: ids, paperclipWake: { comments: ids.map(id => ({ id, readByEarlierTurn: earlier.includes(id) })) } });

it("owes nothing that the turn read at its current revision and cited", () => expect(owedAfterTurn([font, contact], { reads: read, cited: [contact.id, font.id] })).toEqual([]));
it("owes a read that was not cited, a citation without a read, and a stale read", () => {
  expect(owedAfterTurn([font, contact], { reads: read, cited: [font.id] })).toEqual([contact]);
  expect(owedAfterTurn([font, contact], { reads: { [font.id]: font.updatedAt }, cited: [font.id, contact.id] })).toEqual([contact]);
  expect(owedAfterTurn([{ ...font, updatedAt: "2026-11-13T04:05:00.000Z" }], { reads: read, cited: [font.id] })).toHaveLength(1);
});
it("accepts one continuation carrying each owed comment once, JSON-escaped, with an earlier-read warning", () => {
  const prompt = JSON.stringify({ comments: [contact.body] });
  expect(continuationCarriesOwed([font, contact], { reads: read, cited: [font.id] }, { contextSnapshot: wake([contact.id], [contact.id]), prompt })).toBe(true);
  expect(continuationCarriesOwed([font, contact], { reads: {}, cited: [] }, { contextSnapshot: wake([font.id, contact.id]), prompt: `${font.body} ${prompt}` })).toBe(true);
});
it.each([
  ["replays a comment already handled in turn", wake([font.id, contact.id], [contact.id]), `${font.body} ${JSON.stringify(contact.body)}`],
  ["omits the owed comment", wake([], []), JSON.stringify(contact.body)],
  ["delivers it twice", { wakeCommentIds: [contact.id, contact.id], paperclipWake: { comments: [{ id: contact.id, readByEarlierTurn: true }] } }, JSON.stringify(contact.body)],
  ["does not warn that the earlier turn read it", wake([contact.id]), JSON.stringify(contact.body)],
  ["lacks its text in the prompt", wake([contact.id], [contact.id]), "Use the brief."],
])("rejects a continuation that %s", (_label, contextSnapshot, prompt) =>
  expect(continuationCarriesOwed([font, contact], { reads: read, cited: [font.id] }, { contextSnapshot, prompt })).toBe(false));
it("rejects a continuation when nothing was owed", () => expect(continuationCarriesOwed([font], { reads: read, cited: [font.id] }, { contextSnapshot: wake([]), prompt: "" })).toBe(false));
