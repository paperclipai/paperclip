import type { PublicSignInStorage as StorageState } from "./external-public-signin-contract.js";
export interface SlackHumanConnectInput {
  workspaceId: string;
  channelId: string;
  channelName: string;
  senderUserId: string;
  command: string;
  session: StorageState;
  operation?: "connect" | "retry-callback";
  appId?: string;
  callbackURL?: string;
}
export function validSlackHumanConnect(input: SlackHumanConnectInput) {
  if (input.operation === "retry-callback") {
    try {
      const url = new URL(input.callbackURL ?? "");
      if (
        !/^A[A-Z0-9]+$/.test(input.appId ?? "") ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/api\/chat-webhooks\/[a-zA-Z0-9_-]+\/slack$/.test(url.pathname)
      )
        return false;
    } catch {
      return false;
    }
  } else if (
    (input.operation && input.operation !== "connect") ||
    input.appId ||
    input.callbackURL
  )
    return false;

  if (
    !/^T[A-Z0-9]+$/.test(input.workspaceId) ||
    !/^C[A-Z0-9]+$|^G[A-Z0-9]+$/.test(input.channelId) ||
    !/^[a-z0-9_-]{1,80}$/.test(input.channelName) ||
    !/^[UW][A-Z0-9]+$/.test(input.senderUserId) ||
    !/^\/[a-zA-Z0-9_-]{1,100}$/.test(input.command) ||
    !input.session ||
    !Array.isArray(input.session.cookies) ||
    !input.session.cookies.length ||
    input.session.cookies.length > 100 ||
    !Array.isArray(input.session.origins) ||
    input.session.origins.length > 10
  )
    return false;
  return (
    input.session.cookies.every(
      (cookie) =>
        !!cookie &&
        typeof cookie.name === "string" &&
        cookie.name.length > 0 &&
        cookie.name.length <= 200 &&
        typeof cookie.value === "string" &&
        cookie.value.length > 0 &&
        cookie.value.length <= 65536 &&
        cookie.secure === true &&
        /^\.?([a-z0-9-]+\.)*slack\.com$/i.test(cookie.domain) &&
        typeof cookie.path === "string" &&
        cookie.path.startsWith("/"),
    ) &&
    input.session.origins.every((origin) => {
      try {
        const u = new URL(origin.origin);
        return (
          u.protocol === "https:" &&
          /^([a-z0-9-]+\.)*slack\.com$/i.test(u.hostname) &&
          u.origin === origin.origin &&
          !u.username &&
          !u.password &&
          !u.port &&
          Array.isArray(origin.localStorage) &&
          origin.localStorage.length <= 200 &&
          origin.localStorage.every(
            (item) =>
              typeof item.name === "string" &&
              item.name.length <= 1000 &&
              typeof item.value === "string" &&
              item.value.length <= 262144,
          )
        );
      } catch {
        return false;
      }
    })
  );
}
export interface SlackHumanConnectReceipt {
  processIsolation: true;
  testRunnerAttached: false;
  tracingEnabled: false;
  videoEnabled: false;
  verifiedWorkspaceId: string;
  verifiedHumanId: string;
  commandSubmitted?: true;
  callbackRetryRequested?: true;
}
export function validSlackHumanReceipt(
  value: unknown,
  input: Pick<
    SlackHumanConnectInput,
    "workspaceId" | "senderUserId" | "operation"
  >,
) {
  const r = value as Partial<SlackHumanConnectReceipt> | undefined;
  return (
    !!r &&
    Object.keys(r).every((key) =>
      [
        "processIsolation",
        "testRunnerAttached",
        "tracingEnabled",
        "videoEnabled",
        "verifiedWorkspaceId",
        "verifiedHumanId",
        "commandSubmitted",
        "callbackRetryRequested",
      ].includes(key),
    ) &&
    r.processIsolation === true &&
    r.testRunnerAttached === false &&
    r.tracingEnabled === false &&
    r.videoEnabled === false &&
    r.verifiedWorkspaceId === input.workspaceId &&
    r.verifiedHumanId === input.senderUserId &&
    (input.operation === "retry-callback"
      ? r.callbackRetryRequested === true && r.commandSubmitted === undefined
      : r.commandSubmitted === true && r.callbackRetryRequested === undefined)
  );
}
