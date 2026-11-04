/** Independent oracle: a plausible narrative without a persisted decision is not proof. */
export function gradeProviderChoice(
  rows: Array<{ id: string; kind: string; status: string; payload?: any }>,
  calls: number,
) {
  if (calls !== 0)
    throw new Error(
      "Provider executed before the user chose an external service",
    );
  const pending = rows.filter((row) => row.status === "pending");
  if (pending.length !== 1 || pending[0]?.kind !== "ask_user_questions")
    throw new Error("Expected one external-provider question before any setup");
  const question = pending[0].payload?.questions?.find(
    (q: any) => q.id === "connection-provider:hubspot",
  );
  if (
    !question ||
    !/external service/i.test(`${question.prompt} ${question.helpText}`) ||
    !/handle the connection and requests to HubSpot/.test(question.prompt) ||
    !/does not yet authorize HubSpot/.test(question.prompt) ||
    question.selectionMode !== "single"
  )
    throw new Error("Missing app-specific external-service disclosure");
  const ids = question.options.map((option: any) => option.id);
  if (
    JSON.stringify(ids) !==
    JSON.stringify([
      "via:composio:hubspot",
      "via:arcade:hubspot",
      "via:zapier:hubspot",
      "none",
    ])
  )
    throw new Error("Incorrect verified provider ordering or missing None");
  return { interaction: pending[0], question };
}

export function gradeProviderOutcome(input: {
  rows: Array<{ id: string; kind: string; status: string; result?: any }>;
  decisionId: string;
  selected: string;
  calls: number;
  response: string;
  marker: string;
  sameConnections: boolean;
  accessDecision?: { id: string; connectionId: string };
}) {
  const decision = input.rows.find((row) => row.id === input.decisionId);
  const selected = decision?.result?.answers?.find(
    (answer: any) => answer.questionId === "connection-provider:hubspot",
  )?.optionIds;
  return [
    {
      id: "provider-choice-durable",
      passed:
        decision?.status === "answered" &&
        JSON.stringify(selected) === JSON.stringify([input.selected]),
      detail: "The chosen provider or None is saved on this task.",
    },
    {
      id: "provider-no-extra-setup",
      passed: input.sameConnections && (input.accessDecision
        ? input.rows.length === 2 && input.rows.some(row => row.id === input.accessDecision!.id
          && row.kind === "connection_intent" && row.status === "accepted"
          && row.result?.outcome === "connected" && row.result?.connectionId === input.accessDecision!.connectionId)
        : input.rows.length === 1),
      detail: "Only the selected provider and, when needed, its separate approved access card were used; no connection was replaced.",
    },
    {
      id: "provider-use-matches-choice",
      passed:
        input.selected === "none"
          ? input.calls === 0 && !input.response.includes(input.marker)
          : input.calls === 1 && input.response.includes(input.marker),
      detail:
        "None prevents execution; choosing Arcade returns its independently observed marker exactly once.",
    },
  ];
}

/** The provider preference is not an app/tool grant. Require the separate, scoped access card. */
export function requireProviderAccessCard(input: {
  rows: Array<{ id: string; kind: string; status: string; payload?: any }>;
  decisionId: string; connectionId: string; agentId: string; catalogEntryIds: string[]; calls: number;
}) {
  const cards = input.rows.filter(row => row.id !== input.decisionId);
  const card = cards[0];
  const payload = card?.payload;
  const tools = payload?.accessRequest?.tools;
  if (input.calls !== 0 || input.rows.length !== 2 || cards.length !== 1 || card?.kind !== "connection_intent"
    || card.status !== "pending" || payload?.serviceSlug !== "arcade"
    || payload.requestingAgentId !== input.agentId
    || payload.upstreamService?.selectionInteractionId !== input.decisionId
    || payload.upstreamService?.slug !== "hubspot"
    || payload.accessRequest?.connectionId !== input.connectionId
    || !Array.isArray(tools) || tools.length !== 1 || tools[0].toolName !== "Hubspot_ListContacts"
    || tools[0].permission !== "allowed" || input.catalogEntryIds.length !== 1
    || tools[0].catalogEntryId !== input.catalogEntryIds[0]) {
    throw new Error("Expected one scoped Arcade access card after the saved provider choice, before any provider call");
  }
  return card;
}
