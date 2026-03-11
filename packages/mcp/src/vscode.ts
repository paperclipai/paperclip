#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "paperclip-vscode",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const API_URL = process.env.PAPERCLIP_API_URL || "http://localhost:3100/api";
const API_KEY = process.env.PAPERCLIP_API_KEY;

if (!API_KEY) {
  console.error("Warning: PAPERCLIP_API_KEY environment variable is not set.");
}

const vscodeJsonTraining = `
--- JSON Training for VS Code ---
When you retrieve an issue via this MCP, you will receive a JSON payload that looks roughly like this:
{
  "id": "e5c1d3f2...",
  "identifier": "ENG-123",
  "title": "Add rate limiting",
  "description": "Implement an IP-based rate limiter using Redis.",
  "state": { "name": "In Progress" },
  "assignee": { "name": "VS Code User" },
  "relations": []
}
Instruction for VS Code AI Assistant:
1. Use the 'description' field to understand the coding task at hand. It may contain file paths or architectural notes relevant to the current workspace.
2. The 'identifier' (e.g. ENG-123) is the human-readable ID. Use it when suggesting commit messages or branch names.
3. Be aware of the 'title' for broader context while making code changes in the editor.
`;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_issues",
        description: "List issues in the Paperclip workspace. Use this to find work assigned to you. Returns a JSON array of issues. " + vscodeJsonTraining,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free-text search across title and description" },
            teamId: { type: "string", description: "Filter by team ID" },
            limit: { type: "number", description: "Max results. Default: 50" },
          },
        },
      },
      {
        name: "get_issue",
        description: "Retrieve a single issue by ID or identifier (e.g. ENG-123). " + vscodeJsonTraining,
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "UUID or human-readable identifier (e.g. ENG-123)" },
          },
          required: ["id"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!API_KEY) {
    throw new Error("PAPERCLIP_API_KEY is missing. Cannot authenticate with Paperclip.");
  }

  const { name, arguments: args } = request.params;
  const headers = {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    if (name === "list_issues") {
      const url = new URL(`${API_URL}/issues`);
      if (args && typeof args === "object") {
        for (const [key, value] of Object.entries(args)) {
          if (value !== undefined) url.searchParams.append(key, String(value));
        }
      }

      const response = await fetch(url.toString(), { headers });
      if (!response.ok) {
        throw new Error(`Paperclip API error: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } else if (name === "get_issue") {
      const id = args && typeof args === "object" ? args.id : null;
      if (!id) {
        throw new Error("Missing required argument: id");
      }

      const response = await fetch(`${API_URL}/issues/${id}`, { headers });
      if (!response.ok) {
        throw new Error(`Paperclip API error: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Paperclip VS Code MCP server running on stdio");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
