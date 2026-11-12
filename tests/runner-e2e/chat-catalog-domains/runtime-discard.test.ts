import { expect, it } from "vitest";
import { contactSectionRemoved, documentContactRemoved, gradeDiscard, promptCarries, replyLinkHrefs } from "./runtime-discard.js";
function valid() {
  const neighbour = { position: 0, comment: { id: "font", body: "Use a readable font.", authorUserId: "human", authorAgentId: null } };
  return { scenarioId: "steering.discard-queued-message", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "",
    tasks: [{ id: "website", status: "done" }], runs: ["initial", "guidance", "contact", "new-direction", "remove"].map(id => ({ id, status: "succeeded" })),
    activity: [{ id: "discard", action: "issue.queued_comment_discarded", actorType: "user", actorId: "human", entityId: "website", details: { commentId: "pending-contact" } }],
    state: { task: { id: "website" }, humanId: "human", targetId: "pending-contact", queueBefore: { issueId: "website", entries: [neighbour,
      { position: 1, comment: { id: "pending-contact", body: "Also add a contact section to the website.", authorUserId: "human", authorAgentId: null } }] },
    queueAfterDiscard: { issueId: "website", entries: [structuredClone(neighbour)] }, discardVisible: true, discardedCommentStatus: 404, discardedNeverDelivered: true,
    queryReply: "Use the human Discard control on your pending contact request in the task queue.", agentDiscardStatus: 403,
    queryLinkedTask: true, targetPendingAfterReply: true, consumedLabelSaved: true,
    consumedBeforeCancellation: true, consumedStillReadable: true, lateDiscardStatus: 409, latePhaseAttributed: true,
    lateReply: "The later request was already consumed. I sent new direction to remove that section; its original history remains intact.",
    cancelDirectionRunBound: true, finalQueueEmpty: true, finalPlanWithoutContact: true, initialRevisionRetained: true } };
}
it("accepts genuine pending discard and distinct consumed-input cancellation as new direction", () => expect(gradeDiscard(valid()).passed).toBe(true));
it("accepts natural human-control and subsequent consumed-input guidance", () => { const o = valid(); o.state.queryReply = "That waiting message is yours. Open its queue menu and remove it with Discard."; o.state.lateReply = "Morgan processed the second request before you cancelled it. A follow-up now asks for the contact section to be removed; the delivered input stays in history."; expect(gradeDiscard(o).passed).toBe(true); });
it("accepts the retained live reply and a reworded equivalent without wording checks", () => {
  for (const reply of [
    "I found the contact-section request: it's the queued comment on [RUN-1](/RUN/issues/RUN-1), still pending (not yet delivered to Morgan). I couldn't cancel it from this agent: Paperclip returned 403. Since you're the comment author, cancel it from that queued comment's controls on RUN-1.",
    "Only you can pull that one back. It's sitting unsent on [RUN-1](/RUN/issues/RUN-1); open it and use the menu next to the message.",
  ]) { const o = valid(); o.state.queryReply = reply; o.state.lateReply = "Done: Morgan got new instructions to drop that section. Your earlier message is kept as it was."; expect(gradeDiscard(o).passed).toBe(true); }
});
it("rejects guidance that does not link the task holding the queued request", () => { const o = valid(); o.state.queryLinkedTask = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects a reply after which the pending request had already vanished", () => { const o = valid(); o.state.targetPendingAfterReply = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects an empty guidance or later reply", () => {
  const a = valid(); a.state.queryReply = " "; expect(gradeDiscard(a).passed).toBe(false);
  const b = valid(); b.state.lateReply = ""; expect(gradeDiscard(b).passed).toBe(false);
});
it("rejects a saved plan that still carries the cancelled contact label", () => { const o = valid(); o.state.finalPlanWithoutContact = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects a vacuous removal where the consumed contact request was never saved", () => { const o = valid(); o.state.consumedLabelSaved = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects missing cancellation evidence", () => expect(gradeDiscard(undefined).passed).toBe(false));
it("rejects discarding a similarly named request owned by another person", () => { const o = valid(); o.state.queueBefore.entries[1]!.comment.authorUserId = "other"; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects removing unrelated queue content", () => { const o = valid(); o.state.queueAfterDiscard.entries = []; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects missing retained discard history", () => { const o = valid(); o.activity = []; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects a supposedly discarded request that was actually delivered", () => { const o = valid(); o.state.discardedNeverDelivered = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects agent-forged human discard", () => { const o = valid(); o.state.agentDiscardStatus = 200; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects accepting a stale discard of consumed input", () => { const o = valid(); o.state.lateDiscardStatus = 200; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects a later answer borrowed from another native phase", () => { const o = valid(); o.state.latePhaseAttributed = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects new direction never reaching the actual later worker", () => { const o = valid(); o.state.cancelDirectionRunBound = false; expect(gradeDiscard(o).passed).toBe(false); });
it("rejects overwriting the already-delivered historical request", () => { const o = valid(); o.state.consumedStillReadable = false; expect(gradeDiscard(o).passed).toBe(false); });

it.each([403, 500])("rejects late discard status %s even when the human fixture otherwise looks valid", status => {
  const o = valid(); o.state.lateDiscardStatus = status; expect(gradeDiscard(o).passed).toBe(false);
});

it("recognises a multi-line direction carried as JSON in the native prompt, and rejects one that is absent", () => {
  const body = "New direction.\n\n- Remove the contact section.\n- Keep the font guidance.";
  const prompt = `{"messages":[{"body":${JSON.stringify(body)}}]}`;
  expect(promptCarries(prompt, body)).toBe(true);
  expect(promptCarries(prompt.replace("Remove", "Add"), body)).toBe(false);
  expect(promptCarries(undefined, body)).toBe(false);
});
it("reads task links saved in the reply even before they render", () => {
  expect(replyLinkHrefs("Discard it on [RUN-1](/RUN/issues/RUN-1).", [])).toEqual(["/RUN/issues/RUN-1"]);
  expect(replyLinkHrefs("Discard it on RUN-1.", [])).toEqual([]);
});
it("rejects a native prompt that carries other comments but not the direction comment, raw or JSON-escaped", () => {
  const body = "New direction.\n\n- Remove the contact section.\n- Keep the font guidance.";
  const other = "I have changed my mind: add a contact section.\nKeep the font requirement.";
  const prompt = `{"messages":[{"body":${JSON.stringify(other)}}]}\n${other}`;
  expect(promptCarries(prompt, body)).toBe(false);
  // A prefix of the direction is not the direction.
  expect(promptCarries(`{"body":${JSON.stringify("New direction.\n\n- Remove the contact section.")}}`, body)).toBe(false);
  expect(promptCarries(prompt, "")).toBe(false);
});
it("rejects an unbound later worker in the grade when its prompt lacks the direction", () => {
  const o = valid(); o.state.cancelDirectionRunBound = promptCarries(`{"body":${JSON.stringify("unrelated")}}`, "Remove the contact section.\nKeep fonts.");
  expect(gradeDiscard(o).passed).toBe(false);
});
const label = "78f7e3a6c6ec-1";
const initialPlan = "# Website Plan (Initial)\n\n## Status\n\nInitial plan document created.\n\n## Accessible font guidance (retained)\n\n- **Readable base size:** body text at least 16px (1rem).\n";
const consumedPlan = `# Website Plan\n\n## Human direction\n\n- Use a readable font with accessible labels.\n- Add a contact section to the saved website plan, labelled \`${label}\`.\n\n## Status\n\nPlan updated with the requested contact section.\n\n## Contact section (label: ${label})\n\n- **Label:** \`${label}\`\n- **Purpose:** give visitors a clear, accessible way to reach the site owner.\n- **Accessibility requirements:**\n  - Every field has a persistently visible, programmatically associated label.\n\n## Accessible font guidance (retained)\n\n- **Readable base size:** body text at least 16px (1rem).\n`;
it("full cohort 6: the contact section is gone although a superseded note still names its label", () => {
  const final = `# Website Plan\n\n## Human direction\n\n- Use a readable font with accessible labels.\n- No contact section is included; the earlier \`${label}\` contact-section request has been superseded.\n\n## Status\n\nPlan revised: the \`${label}\` contact section has been removed.\n\n## Accessible font guidance (retained)\n\n- **Readable base size:** body text at least 16px (1rem).\n`;
  expect(contactSectionRemoved(consumedPlan, initialPlan, final, label)).toBe(true);
  expect(contactSectionRemoved(consumedPlan, initialPlan, initialPlan, label)).toBe(true);
});
it("reworded valid: a section labelled only in its body is found as the new section carrying the label", () => {
  const consumed = `# Plan\n\n## Fonts\n\n- Accessible fonts.\n\n## Contact\n\nReference: ${label}\n- Contact form with visible labels for every field.\n`;
  expect(contactSectionRemoved(consumed, "# Plan\n\n## Fonts\n\n- Accessible fonts.\n", "# Plan\n\n## Fonts\n\n- Accessible fonts.\n\n## Changes\n\nRemoved the contact section (" + label + ").\n", label)).toBe(true);
});
it("broken: the contact section remains, renamed, emptied of its heading, or was never identifiable", () => {
  expect(contactSectionRemoved(consumedPlan, initialPlan, consumedPlan, label)).toBe(false);
  expect(contactSectionRemoved(consumedPlan, initialPlan, consumedPlan.replace(`## Contact section (label: ${label})`, "## Get in touch"), label)).toBe(false);
  expect(contactSectionRemoved(consumedPlan, initialPlan, consumedPlan.replace(`## Contact section (label: ${label})\n`, ""), label)).toBe(false);
  expect(contactSectionRemoved(`# Plan\n\nLabel ${label} only in the preamble.\n`, undefined, "# Plan\n", label)).toBe(false);
});
it("a line the person asked to keep may stay when the rest of the contact section is gone", () => {
  const consumed = `# Plan\n\n## Fonts\n\n- Readable base size of at least 16px.\n\n## Contact (${label})\n\n- **Label:** \`${label}\`\n- **Purpose:** give visitors a clear way to reach the site owner.\n- Contact form with name, email and message fields.\n- Use a readable font with accessible labels.\n### Accessibility requirements\n- Keep the accessible-font requirement for every form field.\n`;
  const previous = "# Plan\n\n## Fonts\n\n- Readable base size of at least 16px.\n";
  expect(contactSectionRemoved(consumed, previous, "# Plan\n\n## Fonts\n\n- Readable base size of at least 16px.\n- Use a readable font with accessible labels.\n- Keep the accessible-font requirement for every form field.\n", label)).toBe(true);
  const trimmed = "# Plan\n\n## Fonts\n\n- Readable base size of at least 16px.\n\n## Reach us\n\n- **Purpose:** give visitors a clear way to reach the site owner.\n- Contact form with name, email and message fields.\n- Use a readable font with accessible labels.\n";
  expect(contactSectionRemoved(consumed, previous, trimmed, label)).toBe(false);
  expect(contactSectionRemoved(consumed, previous, consumed.replace(`## Contact (${label})`, "## Reach us"), label)).toBe(false);
});
it("compares against the plan from before the consuming run first added the section, across its repeated saves", () => {
  const rows = [
    { id: "r1", revisionNumber: 1, createdByRunId: "initial", body: initialPlan },
    { id: "r2", revisionNumber: 2, createdByRunId: "consumer", body: consumedPlan },
    { id: "r3", revisionNumber: 3, createdByRunId: "consumer", body: `${consumedPlan}\n## Next steps\n\nConfirm contact details with the person.\n` },
    { id: "r4", revisionNumber: 4, createdByRunId: "final", body: initialPlan },
  ];
  expect(documentContactRemoved(rows, "r4", "consumer", label)).toBe(true);
  expect(documentContactRemoved([...rows.slice(0, 3), { ...rows[3]!, body: rows[2]!.body }], "r4", "consumer", label)).toBe(false);
  const bodyLabelled = (body: string) => body.replace(`## Contact section (label: ${label})`, "## Contact section").replace("- Use a readable font with accessible labels.\n- Add a contact section to the saved website plan, labelled", "- Use a readable font with accessible labels.\n- Contact section ref");
  const relabelled = rows.map(row => row.createdByRunId === "consumer" ? { ...row, body: bodyLabelled(row.body) } : row);
  expect(documentContactRemoved(relabelled, "r4", "consumer", label)).toBe(true);
});
