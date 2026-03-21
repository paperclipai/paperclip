import type { MeterEventPayload } from "../types.js";

export type MeterEventInput = {
  costEventId: string;
  stripeCustomerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  occurredAt: string;
};

export function formatMeterEvents(input: MeterEventInput): MeterEventPayload[] {
  const events: MeterEventPayload[] = [];

  if (input.inputTokens > 0) {
    events.push({
      event_name: "llm_token_usage",
      timestamp: input.occurredAt,
      payload: {
        stripe_customer_id: input.stripeCustomerId,
        value: String(input.inputTokens),
        model: input.model,
        token_type: "input",
      },
      identifier: `${input.costEventId}-input`,
    });
  }

  if (input.outputTokens > 0) {
    events.push({
      event_name: "llm_token_usage",
      timestamp: input.occurredAt,
      payload: {
        stripe_customer_id: input.stripeCustomerId,
        value: String(input.outputTokens),
        model: input.model,
        token_type: "output",
      },
      identifier: `${input.costEventId}-output`,
    });
  }

  return events;
}
