const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface RotationTarget { companyId: string; issueId: string; agentId: string; personId: string; gatewayId: string; runIds: string[] }
export interface RotationPublicMessage { companyId: string; agentId: string; runId: string; eventId: string; phase: "commentary" | "final_answer"; body: string }

/** Project completed user-visible messages only, never private reasoning or
 * arbitrary nested tool results that happen to contain convincing prose. */
export function publicRotationMessages(events: unknown[], target: RotationTarget): RotationPublicMessage[] {
  return events.flatMap(value => {
    const event = record(value), prp = record(record(event.payload).prpEvent), item = record(record(prp.payload).item);
    return event.companyId === target.companyId && event.agentId === target.agentId
      && typeof event.runId === "string" && target.runIds.includes(event.runId) && prp.runId === event.runId
      && event.eventType === "item.completed" && item.type === "agentMessage" && item.status === "completed"
      && (item.phase === "commentary" || item.phase === "final_answer") && typeof item.id === "string"
      && typeof item.text === "string" && item.text.length <= 12000
      ? [{ companyId: target.companyId, agentId: target.agentId, runId: event.runId, eventId: item.id, phase: item.phase, body: item.text }] : [];
  });
}

export function rotationQuestionHandoff(cards: unknown[], messages: RotationPublicMessage[], target: RotationTarget) {
  const candidates = cards.map(record).filter(card => card.kind === "ask_user_questions" && card.status === "pending"
    && card.companyId === target.companyId && card.issueId === target.issueId && card.createdByAgentId === target.agentId
    && card.addresseeUserId === target.personId && typeof card.sourceRunId === "string" && target.runIds.includes(card.sourceRunId));
  if (!candidates.length) {
    const message = messages.find(message => message.companyId === target.companyId && message.agentId === target.agentId
      && target.runIds.includes(message.runId) && ["commentary", "final_answer"].includes(message.phase)
      && message.body.includes(target.gatewayId) && /Website test client/i.test(message.body) && /Old test client/i.test(message.body));
    return message ? { interactionId: undefined, runId: message.runId, title: undefined, description: message.body, body: message.body } : undefined;
  }
  if (candidates.length !== 1) return undefined;
  const card = candidates[0]!, description = record(record(card.payload).questionSet).description;
  if (typeof card.id !== "string" || typeof card.title !== "string" || typeof description !== "string"
    || !description.includes(target.gatewayId) || !/Website test client/i.test(description) || !/Old test client/i.test(description)) return undefined;
  const visible = messages.filter(message => message.companyId === target.companyId && message.agentId === target.agentId
    && message.runId === card.sourceRunId && ["commentary", "final_answer"].includes(message.phase));
  return { interactionId: card.id, runId: card.sourceRunId as string, title: card.title, description,
    body: [typeof card.summary === "string" ? card.summary : "", description, ...visible.map(message => message.body)].join("\n") };
}
