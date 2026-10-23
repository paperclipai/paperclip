import { createHash } from "node:crypto";

export interface SecretRef { type: "secret_ref"; secretId: string; version?: number }
export interface Config {
  enabled: boolean;
  workspaceId: string;
  appToken: SecretRef;
  botToken: SecretRef;
  users: { slackUserId: string; boardUserId: string }[];
  projects: { alias: string; projectId: string; agentId: string }[];
}
export interface Message { eventId: string; workspaceId: string; userId: string; channelId: string; ts: string; threadTs: string | null; text: string }
export const MAX_TEXT = 4000;
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function valid(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid Slack control configuration; use the documented IDs and secret references."); }
function secret(value: unknown): SecretRef {
  const item = record(value);
  valid(item.type === "secret_ref" && uuid(item.secretId) && (item.version === undefined || Number.isSafeInteger(item.version) && Number(item.version) > 0));
  valid(Object.keys(item).every((key) => ["type", "secretId", "version"].includes(key)));
  return { type: "secret_ref", secretId: item.secretId, ...(item.version === undefined ? {} : { version: Number(item.version) }) };
}
export function parseConfig(value: unknown): Config | null {
  const item = record(value);
  if (item.enabled !== true) return null;
  valid(Object.keys(item).every((key) => ["enabled", "workspaceId", "appToken", "botToken", "users", "projects"].includes(key)));
  valid(typeof item.workspaceId === "string" && /^T[A-Z0-9]{2,32}$/.test(item.workspaceId));
  valid(Array.isArray(item.users) && item.users.length > 0 && item.users.length <= 10);
  valid(Array.isArray(item.projects) && item.projects.length > 0 && item.projects.length <= 10);
  const users = item.users.map((entry) => {
    const user = record(entry);
    valid(Object.keys(user).every((key) => ["slackUserId", "boardUserId"].includes(key)));
    valid(typeof user.slackUserId === "string" && /^[UW][A-Z0-9]{2,32}$/.test(user.slackUserId));
    valid(typeof user.boardUserId === "string" && user.boardUserId.length > 0 && user.boardUserId.length <= 128);
    return { slackUserId: user.slackUserId, boardUserId: user.boardUserId };
  });
  const projects = item.projects.map((entry) => {
    const project = record(entry);
    valid(Object.keys(project).every((key) => ["alias", "projectId", "agentId"].includes(key)));
    valid(typeof project.alias === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(project.alias) && uuid(project.projectId) && uuid(project.agentId));
    return { alias: project.alias, projectId: project.projectId, agentId: project.agentId };
  });
  valid(new Set(users.map((user) => user.slackUserId)).size === users.length && new Set(projects.map((project) => project.alias)).size === projects.length);
  return { enabled: true, workspaceId: item.workspaceId, appToken: secret(item.appToken), botToken: secret(item.botToken), users, projects };
}
export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function parseMessage(body: unknown, config: Config): Message | null {
  const envelope = record(body); const event = record(envelope.event);
  if (envelope.type !== "event_callback" || envelope.team_id !== config.workspaceId || typeof envelope.event_id !== "string" || !/^Ev[A-Za-z0-9]{1,64}$/.test(envelope.event_id)) return null;
  if (event.type !== "message" || event.channel_type !== "im" || event.subtype !== undefined || event.bot_id !== undefined || event.bot_profile !== undefined || event.app_id !== undefined || event.hidden === true) return null;
  if (event.user_team !== undefined && event.user_team !== config.workspaceId) return null;
  if (typeof event.user !== "string" || !config.users.some((user) => user.slackUserId === event.user)) return null;
  if (typeof event.channel !== "string" || !/^D[A-Z0-9]{2,32}$/.test(event.channel)) return null;
  if (typeof event.text !== "string" || !event.text.trim() || event.text.length > MAX_TEXT) return null;
  if (typeof event.ts !== "string" || !/^\d{10,16}\.\d{6}$/.test(event.ts)) return null;
  if (event.thread_ts !== undefined && (typeof event.thread_ts !== "string" || !/^\d{10,16}\.\d{6}$/.test(event.thread_ts))) return null;
  return { eventId: envelope.event_id, workspaceId: config.workspaceId, userId: event.user, channelId: event.channel, ts: event.ts, threadTs: typeof event.thread_ts === "string" ? event.thread_ts : null, text: event.text.trim() };
}
