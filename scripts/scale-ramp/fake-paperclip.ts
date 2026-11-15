import type { Clock, Fetcher } from "./client.ts";

type Json = Record<string, any>;

export class VirtualClock implements Clock {
  t = Date.parse("2026-11-14T10:00:00.000Z");

  now(): number {
    return this.t;
  }

  async sleep(ms: number): Promise<void> {
    this.t += ms;
    await Promise.resolve();
  }
}

export interface FakeConfig {
  token: string;
  origin: string;
  cloudManaged: boolean;
  agentReadyDelayMs: number | ((index: number) => number);
  agentSetupError: string | null;
  startDelayMs: number;
  runDurationMs: number;
  capacity: number;
  failWhenRunningAbove: number;
  retryOnFailure: boolean;
  costPerRunUsd: number;
  boardLatencyMs: (running: number) => number;
  failRequest: (method: string, path: string, count: number) => { status: number; body: string } | null;
  metricsUrl: string | null;
  metrics: (running: number) => Record<string, unknown> | null;
}

interface FakeRun {
  id: string;
  agentId: string;
  issueId: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  willFail: boolean;
}

export interface RequestLog {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakePaperclip {
  readonly config: FakeConfig;
  readonly requests: RequestLog[] = [];
  readonly companies = new Map<string, Json>();
  readonly agents = new Map<string, Json>();
  readonly issues = new Map<string, Json>();
  readonly runs = new Map<string, FakeRun>();
  readonly secrets = new Map<string, Json>();
  readonly projects = new Map<string, Json>();
  readonly memberCompanyIds: string[] = [];
  readonly environmentId = "00000000-0000-4000-8000-0000000000e1";
  private seq = 0;
  private agentsCreated = 0;
  private counts = new Map<string, number>();

  readonly clock: VirtualClock;

  constructor(clock: VirtualClock, config: Partial<FakeConfig> = {}) {
    this.clock = clock;
    this.config = {
      token: "board-token-value",
      origin: "https://scale1.test.paperclip.app",
      cloudManaged: false,
      agentReadyDelayMs: 3_000,
      agentSetupError: null,
      startDelayMs: 2_000,
      runDurationMs: 60_000,
      capacity: Number.POSITIVE_INFINITY,
      failWhenRunningAbove: Number.POSITIVE_INFINITY,
      retryOnFailure: false,
      costPerRunUsd: 0.01,
      boardLatencyMs: () => 40,
      failRequest: () => null,
      metricsUrl: null,
      metrics: () => null,
      ...config,
    };
  }

  private id(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${this.seq.toString(16).padStart(12, "0")}`;
  }

  addMemberCompany(name: string): string {
    const id = this.id();
    this.companies.set(id, { id, name, status: "active" });
    this.memberCompanyIds.push(id);
    return id;
  }

  addNoiseRuns(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const id = this.id();
      this.runs.set(id, { id, agentId: "noise-agent", issueId: "noise-issue", status: "succeeded", createdAt: this.clock.now() + 1e10 + index,
        startedAt: null, finishedAt: null, willFail: false });
    }
  }

  running(): number {
    return [...this.runs.values()].filter(run => run.status === "running").length;
  }

  liveRuns(): FakeRun[] {
    return [...this.runs.values()].filter(run => ["queued", "running"].includes(run.status));
  }

  private invokable(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    return Boolean(agent && agent.lifecycleState === "ready" && agent.status === "idle");
  }

  advance(): void {
    const now = this.clock.now();
    for (const agent of this.agents.values()) {
      const delay = typeof this.config.agentReadyDelayMs === "function" ? this.config.agentReadyDelayMs(agent.index) : this.config.agentReadyDelayMs;
      if (!["preparing", "verifying"].includes(agent.lifecycleState) || now < agent.createdAt + delay) continue;
      if (this.config.agentSetupError) {
        agent.lifecycleState = "verifying";
        agent.lifecycleError = this.config.agentSetupError;
      } else {
        agent.lifecycleState = "ready";
        agent.status = "idle";
      }
    }
    for (const run of [...this.runs.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (run.status === "running" && run.startedAt !== null && now >= run.startedAt + this.config.runDurationMs) {
        run.finishedAt = run.startedAt + this.config.runDurationMs;
        const issue = this.issues.get(run.issueId)!;
        if (run.willFail) {
          run.status = "failed";
          issue.interruption = this.config.retryOnFailure ? { state: "failed", canRetry: true, retryWait: false } : null;
        } else {
          run.status = "succeeded";
          issue.status = "done";
        }
      }
    }
    for (const run of [...this.runs.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (run.status !== "queued" || now < run.createdAt + this.config.startDelayMs || !this.invokable(run.agentId)) continue;
      if (this.running() >= this.config.capacity) break;
      run.status = "running";
      run.startedAt = Math.max(run.createdAt + this.config.startDelayMs, now - 1_000);
      run.willFail = this.running() > this.config.failWhenRunningAbove;
      this.issues.get(run.issueId)!.status = "in_progress";
    }
  }

  private runRow(run: FakeRun): Json {
    const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
    return {
      id: run.id, agentId: run.agentId, issueId: run.issueId, status: run.status, createdAt: iso(run.createdAt), startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt), costUsd: run.status === "succeeded" || run.status === "failed" ? this.config.costPerRunUsd : null,
      error: null, errorCode: null,
    };
  }

  readonly fetch: Fetcher = async (url, init) => {
    const method = String(init.method ?? "GET");
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? init.body : null;
    this.requests.push({ method, url, authorization: headers.authorization ?? null, body });
    if (this.config.metricsUrl && url === this.config.metricsUrl) {
      this.advance();
      const sample = this.config.metrics(this.running());
      return sample ? json(200, sample) : json(503, { error: "unavailable" });
    }
    const parsed = new URL(url);
    if (parsed.origin !== this.config.origin) throw new Error(`fake: request outside ${this.config.origin}: ${parsed.origin}`);
    if (headers.authorization !== `Bearer ${this.config.token}`) return json(401, { error: "unauthorized" });
    const route = parsed.pathname;
    const key = `${method} ${route.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    const injected = this.config.failRequest(method, key.slice(method.length + 1), count);
    if (injected) return new Response(injected.body, { status: injected.status });
    this.advance();
    return this.route(method, route, parsed.searchParams, body ? JSON.parse(body) as Json : {});
  };

  private route(method: string, route: string, query: URLSearchParams, body: Json): Response {
    const parts = route.split("/").filter(Boolean).slice(1);
    const now = this.clock.now();
    const [a, b, c] = parts;
    if (method === "GET" && a === "cli-auth" && b === "me") return json(200, { companyIds: this.memberCompanyIds });
    if (a === "companies" && !b) {
      if (method === "GET") return json(200, [...this.companies.values()]);
      if (this.config.cloudManaged) return json(403, { error: "Company creation is managed by Paperclip Cloud", code: "cloud_managed" });
      const id = this.id();
      this.companies.set(id, { id, name: body.name, status: "active" });
      this.memberCompanyIds.push(id);
      return json(201, this.companies.get(id));
    }
    if (a === "companies" && b) {
      const companyId = b;
      if (!this.companies.has(companyId)) return json(404, { error: "Company not found" });
      if (!c && method === "GET") return json(200, this.companies.get(companyId));
      if (c === "archive" && method === "POST") {
        this.companies.get(companyId)!.status = "archived";
        return json(200, this.companies.get(companyId));
      }
      if (c === "environments") return json(200, [{ id: this.environmentId, driver: "sandbox", status: "active" }]);
      if (c === "secrets") {
        if (method === "GET") return json(200, [...this.secrets.values()].filter(secret => secret.companyId === companyId).map(({ value: _value, ...rest }) => rest));
        const id = this.id();
        this.secrets.set(id, { id, companyId, name: body.name, value: body.value });
        return json(201, { id, name: body.name });
      }
      if (c === "projects") {
        if (method === "GET") return json(200, [...this.projects.values()].filter(project => project.companyId === companyId));
        const id = this.id();
        this.projects.set(id, { id, companyId, name: body.name, archivedAt: null });
        return json(201, this.projects.get(id));
      }
      if (c === "agents") {
        if (method === "GET") return json(200, [...this.agents.values()].filter(agent => agent.companyId === companyId));
        const id = this.id();
        this.agents.set(id, { id, companyId, name: body.name, status: "paused", lifecycleState: "preparing", lifecycleHolds: [], lifecycleError: null,
          pauseReason: null, createdAt: now, index: this.agentsCreated++, payload: body });
        return json(201, this.agents.get(id));
      }
      if (c === "issues") {
        if (method === "POST") {
          const id = this.id();
          this.issues.set(id, { id, companyId, title: body.title, description: body.description, status: "todo", assigneeAgentId: body.assigneeAgentId,
            projectId: body.projectId ?? null, hiddenAt: null, interruption: null });
          const agent = this.agents.get(body.assigneeAgentId);
          if (agent && agent.status !== "terminated") {
            const runId = this.id();
            this.runs.set(runId, { id: runId, agentId: body.assigneeAgentId, issueId: id, status: "queued", createdAt: now, startedAt: null, finishedAt: null, willFail: false });
          }
          return json(201, this.issues.get(id));
        }
        let list = [...this.issues.values()].filter(issue => issue.companyId === companyId);
        const ids = query.get("ids");
        if (ids) list = list.filter(issue => ids.split(",").includes(issue.id));
        const assignee = query.get("assigneeAgentId");
        if (assignee) list = list.filter(issue => issue.assigneeAgentId === assignee);
        return json(200, list.slice(0, Number(query.get("limit") ?? 500)));
      }
      if (c === "heartbeat-runs") {
        let list = [...this.runs.values()].sort((x, y) => y.createdAt - x.createdAt);
        const agentId = query.get("agentId");
        if (agentId) list = list.filter(run => run.agentId === agentId);
        return json(200, list.slice(0, Math.min(1_000, Number(query.get("limit") ?? 200))).map(run => this.runRow(run)));
      }
      if (["dashboard", "live-runs", "sidebar-badges"].includes(c ?? "")) {
        this.clock.t += this.config.boardLatencyMs(this.running());
        return json(200, c === "live-runs" ? this.liveRuns().map(run => this.runRow(run)) : {});
      }
    }
    if (a === "agents" && b) {
      const agent = this.agents.get(b);
      if (!agent) return json(404, { error: "Agent not found" });
      if (method === "PATCH") {
        Object.assign(agent, body);
        return json(200, agent);
      }
      if (method === "POST" && c === "terminate") {
        agent.status = "terminated";
        agent.lifecycleState = "terminated";
        return json(200, agent);
      }
      if (method === "DELETE") {
        this.agents.delete(b);
        return json(200, { ok: true });
      }
    }
    if (a === "issues" && b) {
      const issue = this.issues.get(b);
      if (!issue) return json(404, { error: "Issue not found" });
      if (method === "GET" && !c) return json(200, issue);
      if (method === "GET" && c === "runs") return json(200, [...this.runs.values()].filter(run => run.issueId === b).map(run => ({ ...this.runRow(run), runId: run.id })));
      if (method === "PATCH") {
        Object.assign(issue, body);
        return json(200, issue);
      }
    }
    if (a === "heartbeat-runs" && b) {
      const run = this.runs.get(b);
      if (!run) return json(404, { error: "Run not found" });
      if (method === "POST" && c === "cancel") {
        if (["queued", "running"].includes(run.status)) {
          run.status = "cancelled";
          run.finishedAt = now;
        }
        return json(200, this.runRow(run));
      }
      if (method === "GET" && c === "events") {
        if (Number(query.get("afterSeq") ?? 0) > 0 || run.startedAt === null) return json(200, []);
        const delay = run.startedAt - run.createdAt;
        return json(200, [
          { seq: 1, eventType: "run.performance.span", createdAt: new Date(run.startedAt).toISOString(), payload: { span: "heartbeat.queue", startOffsetMs: 0, durationMs: delay } },
          { seq: 2, eventType: "run.performance.span", createdAt: new Date(run.startedAt + 3_000).toISOString(),
            payload: { span: "task.time_to_first_agent_activity", startOffsetMs: 0, durationMs: delay + 3_000 } },
          { seq: 3, eventType: "run.performance.span", createdAt: new Date(run.startedAt + 5_000).toISOString(),
            payload: { span: "task.time_to_first_token", startOffsetMs: 0, durationMs: delay + 5_000 } },
        ]);
      }
    }
    if (a === "secrets" && b && method === "DELETE") {
      this.secrets.delete(b);
      return json(200, { ok: true });
    }
    if (a === "projects" && b && method === "PATCH") {
      const project = this.projects.get(b);
      if (!project) return json(404, { error: "Project not found" });
      Object.assign(project, body);
      return json(200, project);
    }
    if (a === "environments" && b === this.environmentId && c === "leases") {
      return json(200, this.liveRuns().map(run => ({ id: run.id, issueId: run.issueId, status: "active" })));
    }
    return json(404, { error: `fake: no route for ${method} ${route}` });
  }
}
