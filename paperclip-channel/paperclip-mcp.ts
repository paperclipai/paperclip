#!/usr/bin/env bun
/**
 * Paperclip MCP Server for claude_local agents
 *
 * Provides Paperclip API tools (inbox, checkout, update, comment, create_issue)
 * over stdio MCP. No HTTP heartbeat listener — that's for VM/channel agents.
 *
 * Environment variables (set by the claude_local adapter during heartbeat runs):
 *   PAPERCLIP_API_URL    — Paperclip API base URL
 *   PAPERCLIP_API_KEY    — Agent or run JWT
 *   PAPERCLIP_AGENT_ID   — This agent's UUID
 *   PAPERCLIP_COMPANY_ID — Company UUID
 *   PAPERCLIP_RUN_ID     — Current heartbeat run ID
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_URL = process.env.PAPERCLIP_API_URL || "http://192.168.4.151:3100/api";
const API_KEY = process.env.PAPERCLIP_API_KEY || "";
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const RUN_ID = process.env.PAPERCLIP_RUN_ID || "";

async function paperclipFetch(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const mcp = new Server(
  { name: "paperclip", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: `Paperclip API tools for managing tasks and issues.

Available tools:
- paperclip_inbox: Check your assigned tasks
- paperclip_checkout: Claim a task before working on it
- paperclip_update: Update task status and add a comment
- paperclip_comment: Add a comment without changing status
- paperclip_create_issue: Create a new issue. Always assign to Coordinator (4f525e83-7b23-47c2-884f-71b6bff440bd) for triage unless creating a message approval for yourself.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "paperclip_inbox",
      description: "Check your Paperclip inbox for assigned tasks.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "paperclip_checkout",
      description: "Claim a task before working on it. Returns 409 if another agent owns it.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "The issue UUID to checkout" },
        },
        required: ["issue_id"],
      },
    },
    {
      name: "paperclip_update",
      description: "Update a task's status and add a comment.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "The issue UUID to update" },
          status: {
            type: "string",
            enum: ["in_progress", "in_review", "done", "blocked"],
            description: "New status",
          },
          comment: { type: "string", description: "Markdown comment describing what was done" },
        },
        required: ["issue_id", "status", "comment"],
      },
    },
    {
      name: "paperclip_comment",
      description: "Add a comment to a task without changing its status.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "The issue UUID" },
          body: { type: "string", description: "Markdown comment" },
        },
        required: ["issue_id", "body"],
      },
    },
    {
      name: "paperclip_create_issue",
      description: "Create a new Paperclip issue for problems you discover during work.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          description: { type: "string", description: "Markdown description" },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Priority level",
          },
          status: {
            type: "string",
            enum: ["backlog", "todo", "in_progress", "in_review"],
            description: "Initial status (default: todo)",
          },
          label_ids: {
            type: "string",
            description: "JSON array of label UUIDs, e.g. '[\"uuid1\"]'",
          },
          assignee_agent_id: {
            type: "string",
            description: "Agent UUID to assign the issue to",
          },
        },
        required: ["title", "description"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments as Record<string, string>;
  const runId = RUN_ID;

  switch (req.params.name) {
    case "paperclip_inbox": {
      const data = await paperclipFetch("GET", `/agents/me/inbox-lite`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    case "paperclip_checkout": {
      const data = await paperclipFetch(
        "POST",
        `/issues/${args.issue_id}/checkout`,
        { agentId: AGENT_ID, expectedStatuses: ["todo", "backlog", "blocked"] },
        runId ? { "X-Paperclip-Run-Id": runId } : {},
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    case "paperclip_update": {
      const data = await paperclipFetch(
        "PATCH",
        `/issues/${args.issue_id}`,
        { status: args.status, comment: args.comment },
        runId ? { "X-Paperclip-Run-Id": runId } : {},
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    case "paperclip_comment": {
      const data = await paperclipFetch(
        "POST",
        `/issues/${args.issue_id}/comments`,
        { body: args.body },
        runId ? { "X-Paperclip-Run-Id": runId } : {},
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    case "paperclip_create_issue": {
      const body: Record<string, unknown> = {
        title: args.title,
        description: args.description,
        priority: args.priority || "high",
        status: args.status || "todo",
      };
      if (args.assignee_agent_id) body.assigneeAgentId = args.assignee_agent_id;
      if (args.label_ids) {
        try { body.labelIds = JSON.parse(args.label_ids); } catch {}
      }
      const data = await paperclipFetch("POST", `/companies/${COMPANY_ID}/issues`, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }
});

await mcp.connect(new StdioServerTransport());
