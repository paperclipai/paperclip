import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CompanyProvider } from "./context/CompanyContext";
import { DialogProvider, useDialog } from "./context/DialogContext";
import { OnboardingWizard } from "./components/OnboardingWizard";
import "./index.css";

/**
 * The real onboarding wizard, with the network stubbed, deployed so the connect
 * step can be walked as the product actually renders it.
 *
 * The sibling `connect-flow-preview` draws the sequence from the same
 * components but drives it with its own state machine. This one renders
 * `OnboardingWizard` itself, so what is on screen is the step's real code path:
 * its phases, its panel, its session handling and its footer.
 *
 * Everything below the app is faked and nothing above it is. Every API call in
 * this codebase goes through one `fetch` in `api/client.ts`, so intercepting
 * that is enough to stand the whole wizard up without a server — no module
 * mocks, and therefore no chance of previewing something other than the code
 * that ships.
 */

const COMPANY = { id: "company-preview", name: "Initech", issuePrefix: "INI" };
const SESSION_ID = "preview-session";
const AUTH_URL = "https://claude.ai/oauth/authorize?code=true&client=paperclip";
const OPENAI_URL = "https://auth.openai.com/codex/device";

/** How long the fake server takes to produce a prompt. */
const PROMPT_LATENCY_MS = 1200;
let sessionStartedAt = 0;
let authenticated = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The canned server.
 *
 * Only the routes the connect step actually reaches. Anything else answers with
 * an empty object rather than a 404: an unhandled call should not be the reason
 * a preview looks broken, and the console still shows what was asked for.
 */
function respond(pathname: string, method: string): Response {
  const has = (p: string) => pathname.includes(p);

  /*
    Ordered most-specific first, and the registry matched at the *end* of the
    path rather than anywhere in it. Several routes live under
    `/adapters/:type` — the model list and the auth signal among them — so a
    substring test for the registry answers those with a list of adapters, and
    the step then tries to sort model ids that are not there.
  */
  if (has("/instance/settings/experimental")) return json({ enableConferenceRoomChat: true });
  if (has("/instance/settings")) return json({ defaultEnvironmentId: "env-sandbox" });

  // No credential anywhere, which is what makes the step offer a sign-in.
  if (has("/auth-signal")) return json({ status: "absent" });
  if (has("/claude-oauth-token-status")) return json({}, 404);
  if (pathname.endsWith("/models")) return json([]);

  if (pathname.endsWith("/environments/capabilities"))
    return json({
      sandboxProviders: {
        daytona: {
          status: "supported",
          supportsSavedProbe: true,
          supportsUnsavedProbe: true,
          supportsRunExecution: true,
          supportsReusableLeases: false,
          supportsInteractiveSetup: false,
          interactiveSetupConnectionTypes: [],
          supportsTemplateCapture: false,
          supportsTemplateDelete: false,
          supportsLoginPty: true,
          source: "plugin",
        },
      },
    });

  if (pathname.endsWith("/environments"))
    return json([
      {
        id: "env-sandbox",
        name: "Daytona",
        description: null,
        driver: "sandbox",
        status: "active",
        config: { provider: "daytona" },
        envVars: {},
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

  if (pathname.endsWith("/adapters"))
    return json(
      [
        ["claude_local", "Claude Code", "submitted_browser_code", "fixed"],
        ["codex_local", "Codex", "displayed_code", "caller_bounded"],
      ].map(([type, label, panelMode, timeoutPolicy]) => ({
        type,
        label,
        source: "builtin",
        modelsCount: 0,
        loaded: true,
        disabled: false,
        capabilities: {
          supportsInstructionsBundle: true,
          supportsSkills: true,
          supportsLocalAgentJwt: true,
          requiresMaterializedRuntimeSkills: false,
          supportsAcp: true,
          login: { panelMode, timeoutPolicy },
        },
      })),
    );

  // The browser-code login: a session, then a prompt once the latency passes.
  if (has("/setup-token-login-sessions")) {
    if (has("/prompt")) {
      const ready = Date.now() - sessionStartedAt > PROMPT_LATENCY_MS;
      return ready ? json({ authorizationUrl: AUTH_URL, transportAdvisory: null }) : json({}, 404);
    }
    if (has("/completion")) return json({ storedSessionId: "stored-preview" });
    if (has("/code")) {
      // Accepted, and the next status read reports the login authenticated.
      authenticated = true;
      return json({ sessionId: SESSION_ID, status: "authenticated" });
    }
    if (has("/cancel")) return json({});
    if (method === "POST") {
      sessionStartedAt = Date.now();
      authenticated = false;
      return json({
        sessionId: SESSION_ID,
        status: "pending",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    return json({
      sessionId: SESSION_ID,
      status: authenticated ? "authenticated" : "pending",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  }

  // The displayed-code login: one session that hands a code over.
  if (has("/login-sessions")) {
    if (has("/cancel")) return json({});
    if (method === "POST") {
      sessionStartedAt = Date.now();
      return json({ sessionId: SESSION_ID, status: "pending" });
    }
    const ready = Date.now() - sessionStartedAt > PROMPT_LATENCY_MS;
    return json({
      sessionId: SESSION_ID,
      status: "pending",
      prompt: ready ? { url: OPENAI_URL, code: "Q2RJ-E1YIF" } : null,
    });
  }

  if (has("/test-environment"))
    return json({
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    });
  if (has("/agent-hires")) return json({ agent: { id: "agent-preview" }, approval: null });
  if (has("/goals")) return json([]);
  if (has("/companies")) return json(method === "POST" ? COMPANY : [COMPANY]);

  return json({});
}


const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  // Only the app's own API is stood in for; anything else (fonts, assets) goes
  // to the network as normal.
  if (!url.includes("/api/")) return realFetch(input as RequestInfo, init);
  const { pathname } = new URL(url, window.location.origin);
  // eslint-disable-next-line no-console
  console.debug("[preview]", method, pathname);
  return respond(pathname, method);
}) as typeof window.fetch;

/** Opens the wizard on the connect step, which is what this page is for. */
function OpenOnConnectStep() {
  const { openOnboarding } = useDialog();
  useEffect(() => {
    openOnboarding({ initialStep: 4, companyId: COMPANY.id });
  }, [openOnboarding]);
  return null;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CompanyProvider>
          <DialogProvider>
            <OpenOnConnectStep />
            <OnboardingWizard />
          </DialogProvider>
        </CompanyProvider>
      </QueryClientProvider>
    </MemoryRouter>
  </StrictMode>,
);
