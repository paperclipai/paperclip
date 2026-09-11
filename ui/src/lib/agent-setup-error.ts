import type { TFunction } from "i18next";

/** Keep local errors translatable while leaving provider/server error text intact. */
export class AgentSetupError extends Error {
  constructor(
    readonly messageKey: string,
    readonly values: Record<string, string> = {},
    readonly previous: Error | null = null,
  ) {
    super(messageKey);
    this.name = "AgentSetupError";
  }
}

export function agentSetupErrorText(error: Error | null, t: TFunction): string | null {
  if (!error) return null;
  if (!(error instanceof AgentSetupError)) return error.message;
  const message = t(error.messageKey, error.values);
  const previous = agentSetupErrorText(error.previous, t);
  return previous ? `${previous} ${message}` : message;
}
