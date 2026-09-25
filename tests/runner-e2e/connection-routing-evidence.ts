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
      passed: input.rows.length === 1 && input.sameConnections,
      detail: "No replacement question or unnecessary connection was created.",
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
