export interface SlackIdentityPrivateInput {
  endpointId: string;
  principalId: string;
  userId: string;
  externalDetail: string;
  externalLabel: string;
}

export function validSlackIdentityInput(
  companyId: unknown,
  input: SlackIdentityPrivateInput | undefined,
  setupURL: string,
) {
  try {
    const url = new URL(setupURL);
    return (
      typeof companyId === "string" &&
      /^[a-f0-9-]{36}$/i.test(companyId) &&
      !!input &&
      /^[a-f0-9-]{36}$/i.test(input.endpointId) &&
      /^[a-f0-9-]{36}$/i.test(input.principalId) &&
      /^[\w-]{1,160}$/.test(input.userId) &&
      /^@[a-zA-Z0-9._-]{1,100}$/.test(input.externalDetail) &&
      !!input.externalLabel.trim() &&
      input.externalLabel.length <= 200 &&
      !/[\r\n]/.test(input.externalLabel) &&
      url.pathname.endsWith(`/apps/chat/${input.endpointId}/access`) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function matchingSlackIdentityPreview(
  value: unknown,
  companyId: string,
  input: SlackIdentityPrivateInput,
) {
  const row = value as
    | {
        companyId?: unknown;
        endpointId?: unknown;
        provider?: unknown;
        externalDetail?: unknown;
        canConfirm?: unknown;
      }
    | undefined;
  return (
    row?.companyId === companyId &&
    row.endpointId === input.endpointId &&
    row.provider === "slack" &&
    row.externalDetail === input.externalDetail &&
    row.canConfirm !== false
  );
}

export function validSlackWizardIdentityInput(
  companyId: unknown,
  input: SlackIdentityPrivateInput | undefined,
  setupURL: string,
) {
  try {
    const url = new URL(setupURL);
    return (
      !!input &&
      validSlackIdentityInput(
        companyId,
        input,
        `${url.origin}/apps/chat/${input.endpointId}/access`,
      ) &&
      url.pathname.endsWith("/apps/chat/connect") &&
      url.searchParams.size === 3 &&
      url.searchParams.get("provider") === "slack" &&
      url.searchParams.get("purpose") === "chat" &&
      url.searchParams.get("resume") === input.endpointId &&
      !url.hash
    );
  } catch {
    return false;
  }
}
