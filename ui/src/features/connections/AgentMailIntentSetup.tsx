import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { isUuidLike } from "@paperclipai/shared";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { AgentMailCredentialField } from "./AgentMailCredentialField";

class ReservedEmailAddressError extends Error {
  constructor(readonly address: string) {
    super(`The address ${address} is already reserved. Finish setup with its saved key.`);
  }
}

interface InlineEmailDraft {
  setupRequestId: string;
  credentialId: string | null;
  inboxConnectionId: string | null;
  selectedCredentialId: string | null;
}
function readDraft(key: string): InlineEmailDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return value && isUuidLike(value.setupRequestId) && ["credentialId", "inboxConnectionId", "selectedCredentialId"]
      .every(field => value[field] === null || typeof value[field] === "string") ? value : null;
  } catch { return null; }
}

/** Same account and inbox APIs as Apps; task setup fixes the access defaults. */
export function AgentMailIntentSetup({ companyId, agentId, requestId, savedCredentialId, readyConnectionId, onComplete, onDecline, declining = false }: {
  companyId: string;
  agentId: string;
  requestId: string;
  savedCredentialId?: string | null;
  readyConnectionId?: string | null;
  onComplete(connectionId: string): Promise<void>;
  onDecline(): void;
  declining?: boolean;
}) {
  useTranslation();
  const draftKey = `paperclip.agentmail-inline:${companyId}:${requestId}`;
  const [draft] = useState(() => readDraft(draftKey));
  const [setupRequestId, setSetupRequestId] = useState(draft?.setupRequestId ?? requestId);
  const [apiKey, setApiKey] = useState("");
  // A refresh can interrupt the response after the server has saved the key.
  // Recover that account unless the user selected another key or started a
  // different setup after the interrupted request.
  const [credentialId, setCredentialId] = useState(draft?.credentialId
    ?? (!draft || (draft.setupRequestId === requestId && !draft.selectedCredentialId) ? savedCredentialId ?? null : null));
  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(draft?.selectedCredentialId ?? null);
  const [inboxConnectionId, setInboxConnectionId] = useState(readyConnectionId ?? draft?.inboxConnectionId ?? null);
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ setupRequestId, credentialId, inboxConnectionId, selectedCredentialId })); }
    catch { /* Keep setup usable without browser storage. */ }
  }, [draftKey, setupRequestId, credentialId, inboxConnectionId, selectedCredentialId]);
  const changeKey = useMutation({
    mutationFn: async (pendingRequestId: string) => {
      const pending = (await emailApi.list(companyId)).find(inbox => inbox.id === pendingRequestId && inbox.status !== "archived");
      if (pending?.address) throw new ReservedEmailAddressError(pending.address);
      if (pending) await emailApi.control(pending.id, "remove");
    },
    onSuccess: () => {
      setSetupRequestId(crypto.randomUUID());
      setCredentialId(null);
      setSelectedCredentialId("");
      setApiKey("");
      setup.reset();
    },
  });
  const setup = useMutation({
    mutationFn: async (submitted: { accountId: string | null; apiKey: string; requestId: string; inboxId: string | null }) => {
      let connectionId = submitted.inboxId;
      if (!connectionId) {
        let accountId = submitted.accountId;
        if (!accountId) {
          const account = await emailApi.connect(companyId, {
            apiKey: submitted.apiKey, grantKind: "organization", allAgents: false,
            agentIds: [agentId], idempotencyKey: submitted.requestId,
          });
          accountId = account.id;
          setCredentialId(accountId);
          setApiKey("");
        }
        setCredentialId(accountId);
        const inbox = await emailApi.setup(companyId, {
          assignedAgentId: agentId, credentialConnectionId: accountId,
          receiveMode: "websocket", idempotencyKey: submitted.requestId,
        });
        connectionId = inbox.connectionId;
        setInboxConnectionId(connectionId);
      }
      // Only the server's completed intent may resume the task. A saved API key
      // alone is not an inbox, and failures remain retryable in this same form.
      await onComplete(connectionId);
      try { sessionStorage.removeItem(draftKey); } catch { /* Optional draft storage. */ }
    },
  });
  return <form className="mt-4 space-y-4" data-testid="agentmail-inline-setup" onSubmit={event => {
    event.preventDefault();
    const accountId = credentialId || selectedCredentialId;
    if (!setup.isPending && !changeKey.isPending && !declining && (accountId || inboxConnectionId || apiKey.trim())) {
      setup.mutate({ accountId, apiKey: apiKey.trim(), requestId: setupRequestId, inboxId: inboxConnectionId });
    }
  }}>
    {credentialId || inboxConnectionId
      ? <p className="text-sm text-muted-foreground">{inboxConnectionId ? t("oct5Apps.copy026") : t("oct5Apps.copy027")}</p>
      : <AgentMailCredentialField companyId={companyId} connectionId={selectedCredentialId}
          onConnectionChange={id => { setSelectedCredentialId(id); setApiKey(""); }}
          value={apiKey} onChange={setApiKey} disabled={setup.isPending || changeKey.isPending || declining} />}
    {credentialId && !inboxConnectionId && <Button type="button" variant="link" size="sm" className="h-auto p-0"
      disabled={setup.isPending || changeKey.isPending || declining} onClick={() => changeKey.mutate(setupRequestId)}>
      {changeKey.isPending ? t("oct5Apps.copy028") : t("oct5Apps.copy029")}
    </Button>}
    {changeKey.error && <p className="text-sm text-destructive" role="alert">{changeKey.error instanceof ReservedEmailAddressError ? t("oct5Apps.reservedAddress", { address: changeKey.error.address }) : changeKey.error.message}</p>}
    {setup.error && <p className="text-sm text-destructive" role="alert">{setup.error.message}</p>}
    <div className="flex items-center justify-between gap-2">
      <Button type="button" variant="ghost" disabled={setup.isPending || changeKey.isPending || declining} onClick={onDecline}>{t("localizationIssueDetail.ui_Not_now")}</Button>
      <Button type="submit" disabled={setup.isPending || changeKey.isPending || declining || (!credentialId && !selectedCredentialId && !inboxConnectionId && !apiKey.trim())}>
        {setup.isPending ? t("sep12Connections.connecting") : inboxConnectionId ? t("pages.inviteLanding.actions.continue") : credentialId ? t("pages.apps.connect.install.finish") : t("oct5Apps.copy030")}
      </Button>
    </div>
  </form>;
}
