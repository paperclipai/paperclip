import { z } from "zod";

/**
 * Agent setup progress: a checklist a person's own agent (outside Paperclip,
 * such as Claude Code on their computer) fills in while it sets something up
 * for them. The setup page creates it and shows the agent's updates live; the
 * agent writes to it with a token from the setup prompt.
 */

export const AGENT_SETUP_PROGRESS_STATUSES = ["waiting", "in_progress", "done", "failed"] as const;
export type AgentSetupProgressStatus = (typeof AGENT_SETUP_PROGRESS_STATUSES)[number];

export const AGENT_SETUP_PROGRESS_ITEM_STATUSES = ["pending", "in_progress", "done", "failed"] as const;
export type AgentSetupProgressItemStatus = (typeof AGENT_SETUP_PROGRESS_ITEM_STATUSES)[number];

/** What can be set up with progress; each page that offers agent setup adds its own. */
export const AGENT_SETUP_PROGRESS_PURPOSES = ["aws_connection"] as const;
export type AgentSetupProgressPurpose = (typeof AGENT_SETUP_PROGRESS_PURPOSES)[number];

export const AGENT_SETUP_PROGRESS_LIMITS = {
  maxItems: 20,
  maxTitleLength: 120,
  maxDetailLength: 500,
  /** Updates the agent may send to one checklist, so a looping agent cannot flood the page. */
  maxUpdates: 300,
  /** How long the agent's token works after the page creates it. */
  lifetimeMs: 6 * 60 * 60 * 1000,
} as const;

export interface AgentSetupProgressItem {
  key: string;
  title: string;
  status: AgentSetupProgressItemStatus;
  detail: string | null;
}

export interface AgentSetupProgress {
  id: string;
  companyId: string;
  purpose: AgentSetupProgressPurpose;
  subjectId: string | null;
  status: AgentSetupProgressStatus;
  items: AgentSetupProgressItem[];
  summary: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Returned once, when the page creates the checklist: everything the agent needs to write to it. */
export interface AgentSetupProgressHandoff {
  progress: AgentSetupProgress;
  /** Sent as `Authorization: Bearer <token>`. Shown only in this response; Paperclip keeps a hash. */
  token: string;
  urls: {
    /** PUT: replace the checklist. */
    checklist: string;
    /** POST: update one item; `{key}` is the item's key. */
    item: string;
    /** POST: say the whole setup is done or failed. */
    finish: string;
  };
}

/** An item key: also part of the item URL, so the Cloud front door can match it exactly. */
export const agentSetupItemKeyPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const itemKey = z.string().trim().regex(agentSetupItemKeyPattern, "Use lowercase letters, numbers, - and _ (up to 40)");
const text = (max: number) => z.string().trim().min(1).max(max);

export const createAgentSetupProgressSchema = z.object({
  purpose: z.enum(AGENT_SETUP_PROGRESS_PURPOSES),
  subjectId: z.string().trim().min(1).max(200).optional(),
}).strict();
export type CreateAgentSetupProgress = z.infer<typeof createAgentSetupProgressSchema>;

export const setAgentSetupChecklistSchema = z.object({
  items: z.array(z.object({
    key: itemKey,
    title: text(AGENT_SETUP_PROGRESS_LIMITS.maxTitleLength),
    status: z.enum(AGENT_SETUP_PROGRESS_ITEM_STATUSES).optional(),
    detail: text(AGENT_SETUP_PROGRESS_LIMITS.maxDetailLength).optional(),
  }).strict()).min(1).max(AGENT_SETUP_PROGRESS_LIMITS.maxItems)
    .refine((items) => new Set(items.map((item) => item.key)).size === items.length, "Each item needs its own key"),
}).strict();
export type SetAgentSetupChecklist = z.infer<typeof setAgentSetupChecklistSchema>;

export const updateAgentSetupItemSchema = z.object({
  status: z.enum(AGENT_SETUP_PROGRESS_ITEM_STATUSES),
  /** Omit to keep the step's detail; send null to clear it (such as after a retry fixed an earlier error). */
  detail: text(AGENT_SETUP_PROGRESS_LIMITS.maxDetailLength).nullable().optional(),
}).strict();
export type UpdateAgentSetupItem = z.infer<typeof updateAgentSetupItemSchema>;

export const finishAgentSetupSchema = z.object({
  status: z.enum(["done", "failed"]),
  summary: text(AGENT_SETUP_PROGRESS_LIMITS.maxDetailLength).optional(),
}).strict();
export type FinishAgentSetup = z.infer<typeof finishAgentSetupSchema>;
