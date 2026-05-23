import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockProviderState {
  account: { id: string; name: string };
  // Per-test overrides:
  tokenStatus?: number;
  tokenBody?: Record<string, unknown>;
  accountStatus?: number;
  accountBody?: Record<string, unknown>;
  expiresInSeconds: number;
  rotatesRefreshToken: boolean;
  refreshCallCount: number;
  consecutiveRefreshFailures: number;
  // Override behavior of /revoke. Default: 200 OK.
  revokeStatus?: number;
  revokeBody?: Record<string, unknown>;
  revokeCallCount: number;
}

export interface MockProvider {
  url: string;
  state: MockProviderState;
  close: () => Promise<void>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const state: MockProviderState = {
    account: { id: "user-1", name: "Test User" },
    expiresInSeconds: 3600,
    rotatesRefreshToken: true,
    refreshCallCount: 0,
    consecutiveRefreshFailures: 0,
    revokeCallCount: 0,
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get("/authorize", (req, res) => {
    // Browsers would render consent UI; tests POST directly to /token, so this is unused in tests.
    // For E2E (Playwright), redirect immediately back with a code.
    const redirect = String(req.query.redirect_uri);
    const code = "mock-code-1";
    const stateP = String(req.query.state);
    const u = new URL(redirect);
    u.searchParams.set("code", code);
    u.searchParams.set("state", stateP);
    res.redirect(302, u.toString());
  });

  app.post("/token", (req, res) => {
    if (state.tokenStatus && state.tokenStatus !== 200) {
      res
        .status(state.tokenStatus)
        .json(state.tokenBody ?? { error: "test_failure" });
      return;
    }
    if (req.body.grant_type === "refresh_token") {
      state.refreshCallCount++;
      if (state.consecutiveRefreshFailures > 0) {
        state.consecutiveRefreshFailures--;
        res.status(500).json({ error: "service_unavailable" });
        return;
      }
    }
    const body: Record<string, unknown> = {
      access_token: `access-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      expires_in: state.expiresInSeconds,
      scope: "read",
      ...(state.rotatesRefreshToken ||
      req.body.grant_type === "authorization_code"
        ? {
            refresh_token: `refresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          }
        : {}),
    };
    res.json(state.tokenBody ?? body);
  });

  app.get("/me", (_req, res) => {
    if (state.accountStatus && state.accountStatus !== 200) {
      res
        .status(state.accountStatus)
        .json(state.accountBody ?? { error: "test_failure" });
      return;
    }
    res.json(state.accountBody ?? state.account);
  });

  app.post("/revoke", (_req, res) => {
    state.revokeCallCount++;
    if (state.revokeStatus && state.revokeStatus !== 200) {
      res
        .status(state.revokeStatus)
        .json(state.revokeBody ?? { error: "test_failure" });
      return;
    }
    res.status(200).end();
  });

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
