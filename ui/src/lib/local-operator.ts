import {
  LOCAL_OPERATOR_FRAGMENT_KEY,
  LOCAL_OPERATOR_HEADER,
  LOCAL_OPERATOR_SOCKET_PARAM,
} from "@paperclipai/shared/local-operator-constants";
import { browserReachableHost } from "./websocket-url";

/**
 * A local board that requires the operator credential signs a browser in
 * through a one-time link. The link's redirect hands this page a token in the
 * URL fragment. The token lives in this origin's storage, which a server on
 * another local port cannot read, and rides on the board's own requests.
 */
const STORAGE_KEY = "paperclip.localOperatorToken";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function localOperatorToken(): string | null {
  try {
    return storage()?.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Moves a token from the sign-in redirect's fragment into storage and removes it from the address bar. */
export function captureLocalOperatorToken(location: Location = window.location, history: History = window.history): void {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = fragment.get(LOCAL_OPERATOR_FRAGMENT_KEY);
  if (!token) return;
  try {
    storage()?.setItem(STORAGE_KEY, token);
  } catch {
    // Without storage the board shows its sign-in screen again.
  }
  fragment.delete(LOCAL_OPERATOR_FRAGMENT_KEY);
  const rest = fragment.toString();
  history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
}

function isSameOrigin(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Adds the operator token to this page's same-origin requests. */
export function installLocalOperatorFetch(target: typeof globalThis = globalThis): void {
  const original = target.fetch.bind(target);
  target.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const token = localOperatorToken();
    if (!token || !isSameOrigin(input)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(LOCAL_OPERATOR_HEADER)) headers.set(LOCAL_OPERATOR_HEADER, token);
    return original(input, { ...init, headers });
  };
}

/** The only sockets that authenticate with the operator token. Others never receive it. */
const OPERATOR_SOCKET_PATHS = [
  /^\/api\/companies\/[^/]+\/events\/ws$/,
  /^\/api\/plugins\/[^/]+\/api\//,
];

/**
 * Adds the operator token to the live-events and plugin sockets this page
 * opens, since a browser cannot set headers on a WebSocket.
 */
export function installLocalOperatorWebSocket(target: typeof globalThis = globalThis): void {
  const Original = target.WebSocket;
  if (!Original) return;
  target.WebSocket = class LocalOperatorWebSocket extends Original {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(withLocalOperatorSocketToken(String(url)), protocols);
    }
  };
}

/** Adds the operator token to a same-origin socket address. */
export function withLocalOperatorSocketToken(url: string): string {
  const token = localOperatorToken();
  if (!token) return url;
  const parsed = new URL(url, window.location.href);
  if (parsed.host !== browserReachableHost(window.location)) return url;
  if (!OPERATOR_SOCKET_PATHS.some((pattern) => pattern.test(parsed.pathname))) return url;
  parsed.searchParams.set(LOCAL_OPERATOR_SOCKET_PARAM, token);
  return parsed.toString();
}

const READ_COOKIE_REFRESH_MS = 4 * 60 * 60 * 1000;

/**
 * Keeps the rotating read cookie current for images and file links, which the
 * browser loads without this page's header. Runs only for a signed-in board.
 */
export function startLocalOperatorReadCookieRefresh(target: typeof globalThis = globalThis): () => void {
  if (!localOperatorToken()) return () => {};
  const refresh = () => {
    void target.fetch("/api/local-operator/read-cookie", { method: "POST", credentials: "same-origin" }).catch(() => {});
  };
  refresh();
  const timer = target.setInterval(refresh, READ_COOKIE_REFRESH_MS);
  return () => target.clearInterval(timer);
}
