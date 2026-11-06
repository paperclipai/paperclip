export interface GrokRoutinePrivateInput {
  agentId: string;
  bindingId: string;
  expectedRevision: number;
  botName: string;
  webhookUrl: string;
}

/** Only the saved agent's exact routine form is admitted by this finite mode.
 * These checks neither connect an account nor qualify a routine roundtrip. */
export function validGrokRoutinePrivateInput(
  companyId: unknown,
  input: GrokRoutinePrivateInput | undefined,
  setupURL: string,
) {
  try {
    const setup = new URL(setupURL);
    if (
      typeof companyId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(companyId) ||
      !input ||
      !/^[a-f0-9-]{36}$/i.test(input.agentId) ||
      !/^[a-f0-9-]{36}$/i.test(input.bindingId) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !input.botName.trim() ||
      input.botName.length > 100 ||
      /[\r\n]/.test(input.botName) ||
      input.webhookUrl.length > 2048 ||
      /[\r\n]/.test(input.webhookUrl) ||
      !setup.pathname.endsWith(`/agents/${input.agentId}/runtime`)
    )
      return false;
    const webhook = new URL(input.webhookUrl);
    return (
      webhook.protocol === "https:" &&
      !webhook.username &&
      !webhook.password &&
      !webhook.hash
    );
  } catch {
    return false;
  }
}

export function matchesConfiguredGrokRoutine(
  value: unknown,
  bindingId: string,
  expectedRevision: number,
) {
  const saved = value as
    | {
        bindingId?: unknown;
        configured?: unknown;
        verified?: unknown;
        revision?: unknown;
      }
    | undefined;
  return (
    saved?.bindingId === bindingId &&
    saved.configured === true &&
    saved.verified === false &&
    saved.revision === expectedRevision + 1
  );
}
