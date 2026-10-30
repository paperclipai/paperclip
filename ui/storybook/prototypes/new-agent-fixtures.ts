import { useEffect, useRef } from "react";
import type { AdapterEnvironmentTestResult, Agent } from "@paperclipai/shared";
import { storybookAgents, storybookIssues } from "../fixtures/paperclipData";

export type TestOutcome = "pass" | "fail";
export type TestState = "idle" | "running" | TestOutcome;
export const PREVIEW_AGENT_ID = "agent-new-agent-preview";
export const PREVIEW_COMPANY_ID = "company-storybook";

export function runtimeTestResult(adapterType: string, outcome: TestOutcome, model: string, environment: string): AdapterEnvironmentTestResult {
  return {
    adapterType, status: outcome, testedAt: new Date().toISOString(),
    checks: outcome === "pass" ? [
      { code: "runtime_available", level: "info", message: `Runtime is available in ${environment}.` },
      { code: "model_response", level: "info", message: `${model || "Default model"} responded successfully.` },
    ] : [
      { code: "model_unavailable", level: "error", message: `${model || "Default model"} could not be reached in ${environment}.`, hint: "Check the model name and provider connection, then test again." },
    ],
  };
}

/** Mounted only by this prototype. The actual API clients and task dialog run
 * against these fixtures; no provider is invoked and no task is persisted. */
export function useNewAgentFixtures(agent: Agent, outcome: TestOutcome, delayMs: number, onTaskCreated: (title: string) => void) {
  const current = useRef({ agent, outcome, delayMs, onTaskCreated });
  current.current = { agent, outcome, delayMs, onTaskCreated };
  useEffect(() => {
    const original = window.fetch;
    const timers = new Map<number, () => void>();
    const fixtureFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const body = async () => JSON.parse(typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "{}");
      const test = url.pathname.match(/^\/api\/companies\/company-storybook\/adapters\/([^/]+)\/test-environment$/);
      if (test && method === "POST") {
        const request = await body();
        const { outcome: result, delayMs: delay } = current.current;
        await new Promise<void>(resolve => {
          const timer = window.setTimeout(() => { timers.delete(timer); resolve(); }, delay);
          timers.set(timer, resolve);
        });
        const environment = request.environmentId === "environment-storybook-sandbox" ? "Paperclip Computer"
          : request.environmentId === "environment-storybook-local" ? "Local machine" : "Organization default";
        return Response.json(runtimeTestResult(test[1], result, request.adapterConfig?.model ?? "", environment));
      }
      if (url.pathname === `/api/companies/${PREVIEW_COMPANY_ID}/agents` && method === "GET") {
        return Response.json([...storybookAgents, current.current.agent]);
      }
      if (url.pathname === `/api/agents/${PREVIEW_AGENT_ID}` && method === "GET") return Response.json(current.current.agent);
      if (url.pathname === `/api/companies/${PREVIEW_COMPANY_ID}/issues` && method === "POST") {
        const request = await body();
        current.current.onTaskCreated(request.title);
        return Response.json({ ...storybookIssues[0], ...request, id: "issue-new-agent-preview", identifier: "PAP-PREVIEW", companyId: PREVIEW_COMPANY_ID });
      }
      return original(input, init);
    };
    window.fetch = fixtureFetch;
    return () => {
      if (window.fetch === fixtureFetch) window.fetch = original;
      for (const [timer, resolve] of timers) { window.clearTimeout(timer); resolve(); }
    };
  }, []);
}
