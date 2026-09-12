import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { fingerprint, uuid, type Message } from "./config.js";

export interface Entry { eventKey: string; configDigest: string; message: Message; phase: "received" | "working" | "done" | "uncertain"; issueId: string | null; outcome: string | null }
export interface Binding { slackUserId: string; boardUserId: string; issueId: string }
export interface Store {
  enqueue(message: Message, configDigest: string): Promise<void>;
  pending(): Promise<Entry[]>;
  recent(): Promise<Pick<Entry, "eventKey" | "phase" | "issueId" | "outcome">[]>;
  claim(eventKey: string): Promise<boolean>;
  finish(eventKey: string, phase: "done" | "uncertain", outcome: string, issueId?: string): Promise<void>;
  binding(message: Message): Promise<Binding | null>;
  bind(message: Message, binding: Binding): Promise<void>;
}
export function eventKey(message: Message): string { return fingerprint([message.workspaceId, message.eventId]); }
export function createStore(db: PluginDatabaseClient, companyId: string): Store {
  if (!uuid(companyId) || !/^plugin_[a-z0-9_]+$/.test(db.namespace)) throw new Error("Invalid plugin storage scope");
  const inbox = `${db.namespace}.inbox`; const threads = `${db.namespace}.threads`;
  return {
    async enqueue(message, configDigest) {
      await db.execute(`INSERT INTO ${inbox} (company_id, event_key, config_digest, message) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (company_id, event_key) DO NOTHING`, [companyId, eventKey(message), configDigest, JSON.stringify(message)]);
    },
    pending: () => db.query<Entry>(`SELECT event_key AS "eventKey", config_digest AS "configDigest", message, phase, issue_id AS "issueId", outcome FROM ${inbox} WHERE company_id = $1 AND phase IN ('received', 'working') ORDER BY updated_at LIMIT 25`, [companyId]),
    recent: () => db.query(`SELECT event_key AS "eventKey", phase, issue_id AS "issueId", outcome FROM ${inbox} WHERE company_id = $1 ORDER BY updated_at DESC LIMIT 25`, [companyId]),
    async claim(key) {
      const result = await db.execute(`UPDATE ${inbox} SET phase = 'working', updated_at = now() WHERE company_id = $1 AND event_key = $2 AND phase = 'received'`, [companyId, key]);
      return result.rowCount === 1;
    },
    async finish(key, phase, outcome, issueId) {
      await db.execute(`UPDATE ${inbox} SET phase = $3, outcome = $4, issue_id = $5, updated_at = now() WHERE company_id = $1 AND event_key = $2`, [companyId, key, phase, outcome, issueId ?? null]);
    },
    async binding(message) {
      const rows = await db.query<Binding>(`SELECT slack_user_id AS "slackUserId", board_user_id AS "boardUserId", issue_id AS "issueId" FROM ${threads} WHERE company_id = $1 AND workspace_id = $2 AND channel_id = $3 AND thread_ts = $4`, [companyId, message.workspaceId, message.channelId, message.threadTs ?? message.ts]);
      return rows[0] ?? null;
    },
    async bind(message, binding) {
      await db.execute(`INSERT INTO ${threads} (company_id, workspace_id, channel_id, thread_ts, slack_user_id, board_user_id, issue_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (company_id, workspace_id, channel_id, thread_ts) DO NOTHING`, [companyId, message.workspaceId, message.channelId, message.threadTs ?? message.ts, binding.slackUserId, binding.boardUserId, binding.issueId]);
      const current = await this.binding(message);
      if (!current || current.issueId !== binding.issueId || current.slackUserId !== binding.slackUserId || current.boardUserId !== binding.boardUserId) throw new Error("Thread binding conflict");
    },
  };
}
