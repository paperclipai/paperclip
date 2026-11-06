import type { PublicSignInStorage } from "./external-public-signin-contract.js";
import type { McpConnectionRequest } from "../../../packages/shared/src/public-mcp.js";
export interface ChatgptInput {
  operation: "availability" | "setup";
  executionId: string;
  attemptId: string;
  receiptPath: string;
  backendOrigin: string;
  publicOrigin: string;
  companyId: string;
  companyName: string;
  prefix: string;
  humanId: string;
  operatorRef: string;
  authorizationRef: string;
  publicSession: PublicSignInStorage;
  control?: {
    id: string;
    identifier: string;
    title: string;
    ownerFact: string;
  };
  executablePath?: string;
  channel?: string;
}
export interface ChatgptReceipt {
  operation: ChatgptInput["operation"];
  executionId: string;
  attemptId: string;
  companyId: string;
  humanId: string;
  processIsolation: true;
  testRunnerAttached: false;
  tracingEnabled: false;
  videoEnabled: false;
  operatorAvailable: true;
  grantId?: string;
  requestId?: string;
  commentId?: string;
  clientRequestId?: string;
  actualChatgptUi?: true;
  realHumanConsent?: true;
  actualProviderCallback?: true;
  boundMcpComment?: true;
  zeroNativeAdmissions?: true;
  requestedScopes?: string[];
  acceptedScopes?: string[];
  configureDisclosed?: boolean;
  consentWording?: string;
}
const uuid = (s: unknown) =>
  typeof s === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
export function namedChatgptRequest(
  r: McpConnectionRequest,
  companyId: string,
) {
  return (
    !!r &&
    /^(?:ChatGPT|OpenAI|OpenAI ChatGPT)$/i.test(r.clientName) &&
    r.redirectOrigin === "https://chatgpt.com" &&
    (!r.clientOrigin || r.clientOrigin === "https://chatgpt.com") &&
    !r.agentConnection &&
    !r.requiresSignIn &&
    r.requestedWrite === true &&
    (!r.requestedCompanyId || r.requestedCompanyId === companyId) &&
    r.companies.some((c) => c.id === companyId && c.canWrite === true)
  );
}
export function validChatgptInput(i: ChatgptInput) {
  try {
    const p = new URL(i.publicOrigin),
      b = new URL(i.backendOrigin),
      ref = (s: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(s);
    return (
      ["availability", "setup"].includes(i.operation) &&
      i.executionId.endsWith(
        ".local.assistant-connections.connect-external-assistant",
      ) &&
      /^[a-f0-9]{32}$/.test(i.attemptId) &&
      i.receiptPath.startsWith("/") &&
      p.protocol === "https:" &&
      p.origin === i.publicOrigin &&
      !p.username &&
      !p.password &&
      b.protocol === "http:" &&
      b.hostname === "127.0.0.1" &&
      b.origin === i.backendOrigin &&
      uuid(i.companyId) &&
      !!i.humanId &&
      i.humanId.length <= 200 &&
      !!i.companyName &&
      /^[A-Z][A-Z0-9]*$/.test(i.prefix) &&
      ref(i.operatorRef) &&
      ref(i.authorizationRef) &&
      !!i.publicSession &&
      Array.isArray(i.publicSession.cookies) &&
      i.publicSession.cookies.length > 0 &&
      i.publicSession.cookies.every(
        (c) => c.secure && c.domain.replace(/^\./, "") === p.hostname,
      ) &&
      i.publicSession.origins.every((o) => o.origin === p.origin) &&
      (i.operation === "availability"
        ? !i.control
        : !!i.control &&
          uuid(i.control.id) &&
          /^[A-Z][A-Z0-9]*-\d+$/.test(i.control.identifier) &&
          i.control.title === "Assistant setup control" &&
          /^[A-Za-z]+ [A-Za-z]+$/.test(i.control.ownerFact))
    );
  } catch {
    return false;
  }
}
export function validChatgptReceipt(r: ChatgptReceipt, i: ChatgptInput) {
  const allowed = [
    "operation",
    "executionId",
    "attemptId",
    "companyId",
    "humanId",
    "processIsolation",
    "testRunnerAttached",
    "tracingEnabled",
    "videoEnabled",
    "operatorAvailable",
    "grantId",
    "requestId",
    "commentId",
    "clientRequestId",
    "actualChatgptUi",
    "realHumanConsent",
    "actualProviderCallback",
    "boundMcpComment",
    "zeroNativeAdmissions",
    "requestedScopes",
    "acceptedScopes",
    "configureDisclosed",
    "consentWording",
  ];
  return (
    !!r &&
    Object.keys(r).every((k) => allowed.includes(k)) &&
    r.operation === i.operation &&
    r.executionId === i.executionId &&
    r.attemptId === i.attemptId &&
    r.companyId === i.companyId &&
    r.humanId === i.humanId &&
    r.processIsolation === true &&
    r.testRunnerAttached === false &&
    r.tracingEnabled === false &&
    r.videoEnabled === false &&
    r.operatorAvailable === true &&
    (i.operation === "availability"
      ? !r.grantId && !r.commentId && !r.realHumanConsent
      : uuid(r.grantId) &&
        uuid(r.commentId) &&
        typeof r.requestId === "string" &&
        !!r.requestId &&
        typeof r.clientRequestId === "string" &&
        !!r.clientRequestId &&
        r.actualChatgptUi === true &&
        r.realHumanConsent === true &&
        r.actualProviderCallback === true &&
        r.boundMcpComment === true &&
        r.zeroNativeAdmissions === true &&
        chatgptConsentDisclosure(
          r.requestedScopes?.includes("paperclip:configure") === true,
          r.consentWording,
          r.configureDisclosed,
        ) &&
        exactAcceptedChatgptScopes(
          r.requestedScopes,
          r.acceptedScopes,
          r.configureDisclosed,
        ))
  );
}
export function setupCheckComment(body: string, owner: string) {
  return (
    !/[@<>]/.test(body) &&
    body
      .trim()
      .replace(/[.!]$/, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase() ===
      `Setup check: the launch owner is ${owner}`.toLowerCase()
  );
}
export function createdChatgptAppId(
  body: unknown,
  name: string,
  requestText: string,
  serverURL: string,
) {
  if (!requestText.includes(name) || !requestText.includes(serverURL)) return;
  const row = body as {
    id?: unknown;
    app?: { id?: unknown };
    connector?: { id?: unknown };
  } | null;
  const id = row?.id ?? row?.app?.id ?? row?.connector?.id;
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(id)
    ? id
    : undefined;
}

/** Saved authority must equal the actual request and explicit human acceptance.
 * Configure is allowed only if its meaning was visibly disclosed on real consent. */
export function exactAcceptedChatgptScopes(
  requested: unknown,
  accepted: unknown,
  configureDisclosed: unknown,
) {
  if (!Array.isArray(requested) || !Array.isArray(accepted)) return false;
  const allowed = [
    "paperclip:read",
    "paperclip:write",
    "paperclip:configure",
    "offline_access",
  ];
  return (
    requested.includes("paperclip:read") &&
    requested.includes("paperclip:write") &&
    requested.every((s) => typeof s === "string" && allowed.includes(s)) &&
    new Set(requested).size === requested.length &&
    new Set(accepted).size === accepted.length &&
    requested.length === accepted.length &&
    requested.every((s) => accepted.includes(s)) &&
    (!requested.includes("paperclip:configure") || configureDisclosed === true)
  );
}

/** Broad actual write consent is supported; configuration acceptance also needs
 * the selected person's explicit private acknowledgement of requested authority. */
export function chatgptConsentDisclosure(
  requestedConfigure: boolean,
  wording: unknown,
  acknowledged: unknown,
) {
  return (
    typeof wording === "string" &&
    wording.trim().replace(/\s+/g, " ") ===
      "Write all of your Paperclip data" &&
    (!requestedConfigure || acknowledged === true)
  );
}
