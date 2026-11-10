import type { PublicSignInStorage } from "./external-public-signin-contract.js";
export interface NotionOAuthInput {
  operation: "save-draft" | "authorize";
  publicOrigin: string;
  companyId: string;
  prefix: string;
  humanId: string;
  agentId: string;
  intentId?: string;
  issueId?: string;
  draftId?: string;
  reconnectId?: string;
  newPersonal?: true;
  workspaceId: string;
  workspaceName: string;
  providerEmail: string;
  publicSession: PublicSignInStorage;
  notionSession: PublicSignInStorage;
}
export interface NotionOAuthReceipt {
  connectionId: string;
  humanId: string;
  intentId: string | null;
  personalDraft: boolean;
  providerHandoff: true;
  credentialAbsentAtHandoff: boolean;
  resumedSameDraft: boolean;
  draftSurvivedReload: boolean;
  consentCompleted: boolean;
  callbackReturned: boolean;
  workspaceMatched: boolean;
  providerHumanMatched: boolean;
  processIsolation: true;
  testRunnerAttached: false;
  tracingEnabled: false;
  videoEnabled: false;
}
const id = (s: string | undefined) =>
  typeof s === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
const notionHost = (host: string) =>
  /^(?:[a-z0-9-]+\.)*notion\.(?:so|com)$/.test(host);
export function notionStorageMatches(
  storage: PublicSignInStorage,
  host: (h: string) => boolean,
) {
  return (
    !!storage &&
    Array.isArray(storage.cookies) &&
    storage.cookies.length > 0 &&
    storage.cookies.length <= 100 &&
    storage.cookies.every(
      (c) =>
        !!c &&
        typeof c.name === "string" &&
        !!c.name &&
        typeof c.value === "string" &&
        c.value.length > 0 &&
        c.value.length <= 65536 &&
        c.secure === true &&
        host(c.domain.replace(/^\./, "")) &&
        c.path.startsWith("/"),
    ) &&
    Array.isArray(storage.origins) &&
    storage.origins.length <= 10 &&
    storage.origins.every((o) => {
      try {
        const u = new URL(o.origin);
        return (
          u.origin === o.origin &&
          u.protocol === "https:" &&
          !u.port &&
          host(u.hostname) &&
          Array.isArray(o.localStorage) &&
          o.localStorage.length <= 200 &&
          o.localStorage.every(
            (x) =>
              typeof x.name === "string" &&
              typeof x.value === "string" &&
              x.value.length <= 262144,
          )
        );
      } catch {
        return false;
      }
    })
  );
}
export function validNotionOAuthInput(input: NotionOAuthInput) {
  try {
    const u = new URL(input.publicOrigin);
    return (
      ["save-draft", "authorize"].includes(input.operation) &&
      u.origin === input.publicOrigin &&
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      [input.companyId, input.humanId, input.agentId, input.prefix].every(id) &&
      (!input.intentId || id(input.intentId)) &&
      !!input.intentId === !!input.issueId &&
      (!input.issueId || id(input.issueId)) &&
      (!input.draftId || id(input.draftId)) &&
      (!input.reconnectId ||
        (id(input.reconnectId) &&
          !input.draftId &&
          !input.newPersonal &&
          !!input.intentId &&
          input.operation === "authorize")) &&
      (!input.newPersonal ||
        (input.newPersonal === true &&
          !input.draftId &&
          !!input.intentId &&
          input.operation === "authorize")) &&
      /^[a-f0-9-]{32,36}$/i.test(input.workspaceId) &&
      typeof input.workspaceName === "string" &&
      input.workspaceName.length > 0 &&
      input.workspaceName.length <= 200 &&
      !/[\r\n\0]/.test(input.workspaceName) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.providerEmail) &&
      input.providerEmail.length <= 254 &&
      notionStorageMatches(input.notionSession, notionHost) &&
      notionStorageMatches(input.publicSession, (h) => h === u.hostname)
    );
  } catch {
    return false;
  }
}
/** A self-tool receipt is read privately; no account names, emails or token
 * material enters the parent. Match ONLY the documented workspace object. */
export function notionSelfWorkspaceMatches(
  value: unknown,
  workspaceId: string,
): boolean {
  let v = value;
  for (let n = 0; n < 4; n++) {
    if (!v || typeof v !== "object") return false;
    const r = v as Record<string, unknown>;
    const workspace = r.workspace as { id?: unknown } | undefined;
    const bot = r.bot as { workspace_id?: unknown } | undefined;
    if (r.type === "bot" && bot && typeof bot.workspace_id === "string")
      return (
        bot.workspace_id.replaceAll("-", "").toLowerCase() ===
        workspaceId.replaceAll("-", "").toLowerCase()
      );
    if (workspace && typeof workspace.id === "string")
      return (
        workspace.id.replaceAll("-", "").toLowerCase() ===
        workspaceId.replaceAll("-", "").toLowerCase()
      );
    if (r.result) {
      v = r.result;
      continue;
    }
    if (
      Array.isArray(r.content) &&
      r.content.length === 1 &&
      r.content[0]?.type === "text" &&
      typeof r.content[0]?.text === "string"
    ) {
      try {
        v = JSON.parse(r.content[0].text);
        continue;
      } catch {
        return false;
      }
    }
    return false;
  }
  return false;
}
export function validNotionOAuthReceipt(
  value: NotionOAuthReceipt,
  input: NotionOAuthInput,
) {
  const keys =
    "callbackReturned,connectionId,consentCompleted,credentialAbsentAtHandoff,draftSurvivedReload,humanId,intentId,personalDraft,processIsolation,providerHandoff,providerHumanMatched,resumedSameDraft,testRunnerAttached,tracingEnabled,videoEnabled,workspaceMatched";
  return (
    !!value &&
    Object.keys(value).sort().join(",") === keys &&
    id(value.connectionId) &&
    (!input.draftId || input.draftId === value.connectionId) &&
    (!input.reconnectId || input.reconnectId === value.connectionId) &&
    value.humanId === input.humanId &&
    value.intentId === (input.intentId ?? null) &&
    value.personalDraft === !input.reconnectId &&
    value.providerHandoff === true &&
    value.credentialAbsentAtHandoff === !input.reconnectId &&
    value.resumedSameDraft === !!input.draftId &&
    value.processIsolation === true &&
    value.testRunnerAttached === false &&
    value.tracingEnabled === false &&
    value.videoEnabled === false &&
    (input.operation === "save-draft"
      ? value.draftSurvivedReload === true &&
        !value.consentCompleted &&
        !value.callbackReturned &&
        !value.workspaceMatched &&
        !value.providerHumanMatched
      : value.consentCompleted === true &&
        value.callbackReturned === true &&
        value.workspaceMatched === true &&
        value.providerHumanMatched === true)
  );
}
