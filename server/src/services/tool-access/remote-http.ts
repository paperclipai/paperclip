import { assertConfiguredTokenBrokerEndpointsAllowed } from "./token-broker/endpoint-policy.js";
import { remoteEndpoint } from "./connection-methods.js";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { badRequest, HttpError } from "../../errors.js";
import { assertPublicRemoteHttpEndpoint, parseRemoteHttpEndpoint, type RemoteHttpEndpointLookup } from "../remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch, type GuardedRemoteHttpFetchOptions } from "../remote-http-fetch.js";

const REMOTE_HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const MAX_REMOTE_HTTP_REDIRECTS = 5;

type RemoteHttpOptions = {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  remoteHttpEndpointLookup?: RemoteHttpEndpointLookup;
  remoteHttpRequest?: (url: string, init: RequestInit) => Promise<Response>;
};

export function createToolRemoteHttp(options: RemoteHttpOptions) {
  function allowPrivateRemoteEndpoints() {
    return (
      options.deploymentMode !== "authenticated" ||
      options.deploymentExposure !== "public"
    );
  }

  async function assertRemoteHttpUrlAllowed(value: string): Promise<string> {
    const endpoint = parseRemoteHttpEndpoint(value, (message, code) =>
      badRequest(message, { code }),
    );
    await assertPublicRemoteHttpEndpoint(
      endpoint,
      {
        allowPrivateNetwork: allowPrivateRemoteEndpoints(),
        lookup: options.remoteHttpEndpointLookup,
      },
      (message, code) => badRequest(message, { code }),
    );
    return endpoint.toString();
  }

  function remoteHttpFetchOptions(): GuardedRemoteHttpFetchOptions {
    return {
      allowPrivateNetwork: allowPrivateRemoteEndpoints(),
      lookup: options.remoteHttpEndpointLookup,
      error: (message, code) => badRequest(message, { code }),
    };
  }

  async function requestRemoteHttpEndpoint(
    endpoint: URL,
    init: RequestInit,
  ): Promise<Response> {
    return options.remoteHttpRequest
      ? options.remoteHttpRequest(endpoint.toString(), {
          ...init,
          redirect: "manual",
        })
      : guardedRemoteHttpFetch(endpoint, init, remoteHttpFetchOptions());
  }

  /**
   * Fetch an operator-supplied remote URL with the egress guard bound to the
   * connection itself.
   *
   * `guardedRemoteHttpFetch` resolves the hostname once and dials the approved
   * address, so a name server that answers public-then-private cannot move the
   * connection onto a loopback or metadata address after validation
   * (PAP-17098). Redirects stay manual and run the full guard again on the next
   * hop, because a `Location` is just as attacker-controlled as the first URL.
   */
async function fetchRemoteHttpUrl(
    value: string,
    init: RequestInit = {},
  ): Promise<Response> {
    let currentUrl = value;
    const method = (init.method ?? "GET").toUpperCase();
    for (
      let redirectCount = 0;
      redirectCount <= MAX_REMOTE_HTTP_REDIRECTS;
      redirectCount += 1
    ) {
      const endpoint = parseRemoteHttpEndpoint(currentUrl, (message, code) =>
        badRequest(message, { code }),
      );
      const response = await requestRemoteHttpEndpoint(endpoint, init);
      const location = REMOTE_HTTP_REDIRECT_STATUSES.has(response.status)
        ? (response.headers?.get?.("location") ?? null)
        : null;
      if (!location) return response;
      if (method !== "GET" && method !== "HEAD") {
        throw new HttpError(
          502,
          "Remote OAuth endpoint redirected unexpectedly",
          { code: "oauth_redirect_rejected" },
        );
      }
      if (redirectCount >= MAX_REMOTE_HTTP_REDIRECTS) {
        throw new HttpError(
          502,
          "Remote OAuth endpoint redirected too many times",
          { code: "oauth_redirect_limit" },
        );
      }
      currentUrl = new URL(location, endpoint).toString();
    }
    throw new HttpError(
      502,
      "Remote OAuth endpoint redirected too many times",
      { code: "oauth_redirect_limit" },
    );
  }

  async function assertRemoteEndpointAllowed(
    config: Record<string, unknown>,
  ): Promise<string> {
    return assertRemoteHttpUrlAllowed(remoteEndpoint(config));
  }

  async function assertRemoteConnectionEndpointsAllowed(
    config: Record<string, unknown>,
  ): Promise<string> {
    const endpoint = await assertRemoteEndpointAllowed(config);
    await assertConfiguredTokenBrokerEndpointsAllowed(config);
    return endpoint;
  }
  return { allowPrivateRemoteEndpoints, assertRemoteHttpUrlAllowed, requestRemoteHttpEndpoint, fetchRemoteHttpUrl, assertRemoteEndpointAllowed, assertRemoteConnectionEndpointsAllowed };
}
export type ToolRemoteHttp = ReturnType<typeof createToolRemoteHttp>;
