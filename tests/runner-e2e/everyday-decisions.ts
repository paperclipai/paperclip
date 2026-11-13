export interface StoryInteraction {
  id: string;
  kind: string;
  status: string;
  title?: string;
  payload?: {
    serviceSlug?: string;
    toolAction?: { connectionId?: string; actionRequestId?: string };
  };
}
export type StoryDecision =
  | { kind: "tool"; connectionId: string }
  | { kind: "connection"; serviceSlug: string };
export class StoryDecisionError extends Error {
  readonly checkId = "decision-request-matches-story";
}
export function pendingStoryDecision(
  rows: StoryInteraction[],
  expected: StoryDecision,
): StoryInteraction {
  const pending = rows.filter((row) => row.status === "pending");
  if (pending.length !== 1)
    throw new StoryDecisionError(
      `Expected exactly one pending decision; observed ${pending.length}.`,
    );
  const interaction = pending[0]!;
  if (expected.kind === "tool") {
    if (
      interaction.kind !== "request_confirmation" ||
      !interaction.payload?.toolAction?.actionRequestId
    )
      throw new StoryDecisionError(
        `Expected a tool action review for the installed service; observed ${interaction.kind}: ${interaction.title ?? "untitled"}. No decision was taken.`,
      );
    if (interaction.payload.toolAction.connectionId !== expected.connectionId)
      throw new StoryDecisionError(
        "The tool approval belongs to a different connection. No decision was taken.",
      );
  } else if (
    interaction.kind !== "connection_intent" ||
    interaction.payload?.serviceSlug !== expected.serviceSlug
  ) {
    throw new StoryDecisionError(
      `Expected connection_intent for ${expected.serviceSlug}; observed ${interaction.kind} for ${interaction.payload?.serviceSlug ?? "unknown service"}. No decision was taken.`,
    );
  }
  return interaction;
}
