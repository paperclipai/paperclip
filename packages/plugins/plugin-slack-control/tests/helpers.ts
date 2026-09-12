import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { vi } from "vitest";
import type { Config, Message } from "../src/config.js";

export const company = "00000000-0000-0000-0000-000000000001";
export const otherCompany = "00000000-0000-0000-0000-000000000002";
export const projectId = "00000000-0000-0000-0000-000000000003";
export const agentId = "00000000-0000-0000-0000-000000000004";
export const issueId = "00000000-0000-0000-0000-000000000005";
export const namespace = "plugin_slack_control_608eeb9089";
export const config: Config = { enabled: true, workspaceId: "TTEST", appToken: { type: "secret_ref", secretId: projectId }, botToken: { type: "secret_ref", secretId: agentId }, users: [{ slackUserId: "UTEST", boardUserId: "human" }], projects: [{ alias: "demo", projectId, agentId }] };
export const message: Message = { eventId: "Ev001", workspaceId: config.workspaceId, userId: "UTEST", channelId: "DTEST", ts: "1780000000.000001", threadTs: null, text: "new demo: Synthetic task" };
export function envelope(patch: Record<string, unknown> = {}) {
  return { type: "event_callback", event_id: message.eventId, team_id: message.workspaceId,
    event: { type: "message", channel_type: "im", user: message.userId, channel: message.channelId, ts: message.ts, text: message.text, ...patch } };
}
export function database(pg: PGlite): PluginDatabaseClient {
  return { namespace,
    async query<T>(sql: string, params?: unknown[]) { return (await pg.query(sql, params)).rows as T[]; },
    async execute(sql, params) { return { rowCount: (await pg.query(sql, params)).affectedRows ?? 0 }; },
  };
}
export async function initialise(pg: PGlite) {
  await pg.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); INSERT INTO public.companies VALUES ('${company}'), ('${otherCompany}'); CREATE SCHEMA ${namespace}`);
  await pg.exec(await readFile(new URL("../migrations/001_inbox.sql", import.meta.url), "utf8"));
}
export function host(db: PluginDatabaseClient) {
  const issue = { id: issueId, companyId: company, projectId, assigneeAgentId: agentId, createdByUserId: "human", identifier: "DEMO-1", status: "todo", title: "Synthetic task" };
  const api = {
    db, logger: { warn: vi.fn(), error: vi.fn() },
    access: { members: { list: vi.fn().mockResolvedValue([{ companyId: company, principalType: "user", principalId: "human", status: "active", membershipRole: "owner" }]) } },
    projects: { get: vi.fn().mockResolvedValue({ id: projectId, companyId: company }) },
    agents: { get: vi.fn().mockResolvedValue({ id: agentId, companyId: company, status: "idle" }) },
    issues: { list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue(issue), create: vi.fn().mockResolvedValue(issue),
      createComment: vi.fn().mockResolvedValue({ id: "comment" }), listComments: vi.fn().mockResolvedValue([]), requestWakeup: vi.fn().mockResolvedValue({ status: "queued" }) },
  };
  return { api, ctx: api as unknown as PluginContext, issue };
}
