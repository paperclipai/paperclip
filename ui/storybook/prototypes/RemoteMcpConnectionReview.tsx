import { useEffect, useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolConnectionAccessSummary, ToolConnectionTestAgent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { RemoteMcpConnectionSetup } from "@/features/connections/remote-mcp/RemoteMcpConnectionSetup";
import { remoteMcpProviders, type RemoteMcpProviderId } from "@/features/connections/remote-mcp/providers";
import type { RemoteMcpSetupActions, RemoteMcpSetupState } from "@/features/connections/remote-mcp/types";
import { exampleUrl, fixtureTools, initialReviewState, newFixtureTool, reviewAgents, type ReviewScenario } from "../fixtures/remoteMcpConnections";

/** Provider responses are simulated in memory. The saved connection uses the real
 * Permissions action list and its real Test dialog, with scoped API fixtures. */
export function RemoteMcpConnectionReview({ provider, scenario = "journey" }: { provider: RemoteMcpProviderId; scenario?: ReviewScenario }) {
  const connectionId = `review-${provider}`;
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }), [provider, scenario]);
  const [s, setState] = useState(() => initialReviewState(provider, scenario));
  const [connectOutcome, setConnectOutcome] = useState("success");
  const [callOutcome, setCallOutcome] = useState(scenario === "provider_pending" ? "provider" : "success");
  const [refreshOutcome, setRefreshOutcome] = useState("add");
  const [external, setExternal] = useState<string | null>(null);
  const [calls, setCalls] = useState(0);
  const latest = useRef({ state: s, callOutcome });
  latest.current = { state: s, callOutcome };
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const savedStep = useRef<RemoteMcpSetupState["step"]>("connect");
  const edit = (patch: Partial<RemoteMcpSetupState>) => setState((current) => ({ ...current, ...patch }));
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => { clearTimers(); setState(initialReviewState(provider, scenario)); setExternal(null); setCalls(0); return clearTimers; }, [provider, scenario]);
  const later = (action: () => void) => { timers.current.push(setTimeout(action, 500)); };

  useEffect(() => {
    const agents: ToolConnectionTestAgent[] = reviewAgents.map((agent) => ({ ...agent, role: "engineer", title: null, status: "active", orgDepth: 0 }));
    client.setQueryData(queryKeys.tools.catalog(connectionId), { catalog: s.tools });
    client.setQueryData(queryKeys.tools.testAgents(connectionId), { agents });
    for (const agent of agents) {
      const tools: ToolConnectionAccessSummary["tools"] = s.tools.map((tool) => ({
        toolName: tool.toolName, gatewayToolName: `${provider}__${tool.toolName}`, displayName: tool.title,
        risk: tool.isReadOnly ? "read" : "write", matchedPolicyIds: [], reasonCode: null,
        decision: !s.connected || (!s.allAgents && !s.agentIds.includes(agent.id)) ? "off" : s.permissions[tool.id] ?? "allowed",
      }));
      const access: ToolConnectionAccessSummary = { connectionId, tools, toolCount: tools.length,
        allowedCount: tools.filter((t) => t.decision === "allowed").length,
        askFirstCount: tools.filter((t) => t.decision === "ask_first").length,
        offCount: tools.filter((t) => t.decision === "off").length,
        lastChangedAt: null, lastChangedByAgentId: null, lastChangedByName: null };
      client.setQueryData(queryKeys.tools.testAgentAccess(connectionId, agent.id), { access });
    }
  }, [client, connectionId, provider, s.connected, s.tools, s.permissions, s.allAgents, s.agentIds]);

  useEffect(() => {
    const original = window.fetch;
    const prefix = `/api/tool-connections/${connectionId}/`;
    const mockedFetch: typeof window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (!url.pathname.startsWith(prefix)) return original(input, init);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname === `${prefix}test-calls` && method === "POST") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "{}");
        const { state, callOutcome: outcome } = latest.current;
        const tool = state.tools.find((entry) => entry.toolName === body.toolName);
        const decision = !tool || !state.connected || (!state.allAgents && !state.agentIds.includes(body.agentId)) ? "off" : state.permissions[tool.id] ?? "allowed";
        if (decision === "off") return Response.json({ decision, invocationId: "review-blocked", error: { message: "This agent cannot run this action.", reasonCode: null } });
        if (decision === "ask_first") return Response.json({ decision, invocationId: "review-parked", actionRequestId: "review-approval" });
        setCalls((value) => value + 1);
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        if (outcome === "provider" && body.toolName !== "resume") return Response.json({ decision, invocationId: "review-call", upstreamPending: provider === "executor"
          ? { kind: "approval", links: [], executionId: "review-execution-001", resumeTool: "resume", message: "Approve the example documentation read?", requestedSchema: { type: "object", properties: {} } }
          : { kind: "authorization", links: [{ url: "https://provider.example.invalid/authorize", host: "provider.example.invalid" }] } });
        if (body.toolName === "resume" && typeof body.parameters.content !== "string" && body.parameters.action === "accept") return Response.json({ decision, invocationId: "review-resume", error: { message: "Resume content must be JSON encoded.", reasonCode: "invalid_arguments" } });
        if (body.toolName === "resume" && ["decline", "cancel"].includes(body.parameters.action)) return Response.json({ decision, invocationId: "review-resume", error: { message: `Tool requires approval but the request was ${body.parameters.action === "decline" ? "declined" : "cancelled"} by the user.`, reasonCode: "tool_error" } });
        return Response.json({ decision, invocationId: "review-call", ...(outcome === "error" ? { error: { message: "Review resource was not found. Check the arguments.", reasonCode: null } } : { result: { example: true, message: "Review action completed", provider } }) });
      }
      if (url.pathname === `${prefix}test-calls/review-approval`) return Response.json({ actionRequestId: "review-approval", invocationId: "review-parked", phase: "waiting" });
      // Never send synthetic connection requests to a real server, including misses.
      return Response.json({ error: "No Storybook fixture for this request." }, { status: 501 });
    };
    window.fetch = mockedFetch;
    return () => { if (window.fetch === mockedFetch) window.fetch = original; client.clear(); };
  }, [client, connectionId]);

  const connected = () => setState((current) => {
    const tools = current.tools.length ? current.tools : fixtureTools(provider);
    return { ...current, connected: true, setupComplete: true, connectStatus: "returned", step: "permissions",
      identity: provider === "zapier" ? null : "reviewer@example.invalid", tools,
      permissions: Object.fromEntries(tools.map((tool) => [tool.id, current.permissions[tool.id] ?? "allowed"])) };
  });
  const deliverConnection = () => {
    if (["rejected", "unreachable"].includes(connectOutcome)) edit({ connectStatus: connectOutcome as "rejected" | "unreachable" });
    else if (s.auth === "auto" && remoteMcpProviders[provider].supportsBrowserAuth) edit({ connectStatus: "sign_in" });
    else connected();
  };
  const actions: RemoteMcpSetupActions = {
    edit, navigate: (step) => edit({ step, notice: null }),
    connect: () => {
      try { const url = new URL(s.url); if (!["https:", "http:"].includes(url.protocol) || !url.hostname) throw new Error("invalid"); }
      catch { edit({ connectStatus: "invalid_url" }); return; }
      if ((s.auth === "bearer" && !s.token.trim()) || (s.auth === "headers" && (!s.headers.length || s.headers.some((h) => !h.name.trim() || !h.value.trim())))) { edit({ connectStatus: "rejected" }); return; }
      edit({ connectStatus: "connecting", notice: null }); later(deliverConnection);
    },
    cancelConnect: () => { clearTimers(); edit({ connectStatus: "cancelled" }); },
    openProvider: (purpose) => setExternal(`${remoteMcpProviders[provider].name}: ${purpose === "setup" ? "setup documentation" : purpose === "manage" ? "provider dashboard" : "sign-in window"}. External navigation is simulated.`),
    saveExit: () => { savedStep.current = s.step; edit({ step: "draft", notice: "Review draft saved in memory for this preview. Reloading clears it; no credentials are stored." }); },
    resumeDraft: () => edit({ step: savedStep.current, notice: "Resumed your setup with its previous choices." }),
    finish: () => edit({ step: "management", notice: null }),
    refresh: () => {
      edit({ refreshing: true });
      later(() => setState((current) => {
        const tools = refreshOutcome === "remove" ? current.tools.slice(0, -1) : current.tools.some((tool) => tool.id === newFixtureTool.id) ? current.tools : [...current.tools, { ...newFixtureTool, connectionId }];
        const permissions = Object.fromEntries(tools.map((tool) => [tool.id, current.permissions[tool.id] ?? "allowed"]));
        return { ...current, tools, permissions, refreshing: false, notice: refreshOutcome === "remove" ? "Disappeared tools were removed. Remaining permission choices are unchanged." : "Catalog refreshed. New tools are Allowed; existing Off and Ask first choices are preserved." };
      }));
    },
    reconnect: () => edit({ step: "connect", connectStatus: "idle", notice: "Reconnect this connection. Saved agent access and tool permissions will be retained." }),
    disconnect: () => { clearTimers(); edit({ connected: false, token: "", headers: [], url: "", notice: "Connection credentials revoked. Further calls through Paperclip are blocked." }); },
  };
  const reset = () => { clearTimers(); client.clear(); setState(initialReviewState(provider, scenario)); setCalls(0); setExternal(null); setConnectOutcome("success"); setCallOutcome("success"); };

  return <QueryClientProvider client={client}><div className="min-h-screen bg-background text-foreground" onClickCapture={(event) => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (anchor?.href.includes("provider.example.invalid")) { event.preventDefault(); event.stopPropagation(); setExternal("Provider authorization simulated. No external request was made."); }
    }}>
    <div className="border-b border-border bg-muted px-4 py-3 text-sm" role="note"><strong>Design review · {remoteMcpProviders[provider].name}</strong><span className="text-muted-foreground"> — Example accounts and tools. No real sign-in, calls, or credential storage. Use fake values only.</span></div>
    <RemoteMcpConnectionSetup connectionId={connectionId} provider={remoteMcpProviders[provider]} state={s} actions={actions} agents={reviewAgents} />
    <aside aria-label="Storybook simulation" className="mx-auto max-w-6xl space-y-4 border-t border-border p-4 sm:p-8">
      <p className="text-xs font-semibold text-muted-foreground">STORYBOOK SIMULATION</p>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        {!s.setupComplete && <label className="space-y-1">Connection response<select aria-label="Connection response" className="block rounded-md border border-input bg-background p-2" value={connectOutcome} onChange={(event) => setConnectOutcome(event.target.value)}><option value="success">Connected</option><option value="rejected">Rejected credentials</option><option value="unreachable">Unreachable endpoint</option></select></label>}
        {s.setupComplete && <>
          <label className="space-y-1">Test response<select aria-label="Test response" className="block rounded-md border border-input bg-background p-2" value={callOutcome} onChange={(event) => setCallOutcome(event.target.value)}><option value="success">Success</option><option value="error">Failure</option>{provider !== "zapier" && <option value="provider">Provider authorization / approval</option>}</select></label>
          <label className="space-y-1">Catalog change<select aria-label="Catalog change" className="block rounded-md border border-input bg-background p-2" value={refreshOutcome} onChange={(event) => setRefreshOutcome(event.target.value)}><option value="add">Add a tool</option><option value="remove">Remove last tool</option></select></label>
        </>}
      </div>
      <div className="flex flex-wrap gap-2">
        {s.step === "connect" && !["connecting", "sign_in", "returned"].includes(s.connectStatus) && <Button variant="outline" size="sm" onClick={() => edit({ url: exampleUrl(provider), token: "review-only-not-a-secret", headers: s.headers.map((h) => ({ ...h, value: "review-user" })) })}>Use example configuration</Button>}
        {s.connectStatus === "connecting" && <Button variant="outline" size="sm" onClick={() => { clearTimers(); deliverConnection(); }}>Deliver server response</Button>}
        {s.connectStatus === "sign_in" && <Button variant="outline" size="sm" onClick={connected}>Complete sign-in (simulation)</Button>}
        <Button variant="ghost" size="sm" onClick={reset}>Reset preview</Button>
      </div>
      {external && <p role="status" className="text-sm text-muted-foreground">{external}</p>}
      <p className="font-mono text-xs text-muted-foreground">Simulated action calls: {calls}</p>
    </aside>
  </div></QueryClientProvider>;
}
