export type McpUserStoryStatus = "runnable" | "dependency_gated";

export interface McpUserStory {
  id: `US-${number}`;
  title: string;
  personas: string[];
  status: McpUserStoryStatus;
  gate?: string;
  assertions: string[];
}

export const mcpUserStories: McpUserStory[] = [
  {
    id: "US-1",
    title: "First connector, five minutes",
    personas: ["Casey", "Scout"],
    status: "runnable",
    assertions: [
      "Apps connect journey reaches a connected app without admin Tools navigation.",
      "A read tool runs through the gateway as Scout.",
      "Activity/audit evidence attributes the call to the selected Scout agent.",
    ],
  },
  {
    id: "US-2",
    title: "Ask-first write, approved",
    personas: ["Casey", "Scout"],
    status: "runnable",
    assertions: [
      "A side-effecting tool parks as an action request.",
      "Approval executes the parked call exactly once.",
      "Review and activity surfaces preserve the request-to-execution chain.",
    ],
  },
  {
    id: "US-3",
    title: "Ask-first, denied/expired",
    personas: ["Ana", "Scout"],
    status: "runnable",
    assertions: [
      "A denied action request returns a governed denial state.",
      "The denied call does not reach the fixture server.",
      "Review history and audit evidence expose the denial.",
    ],
  },
  {
    id: "US-4",
    title: "Deny policy wins",
    personas: ["Ana", "Scout"],
    status: "runnable",
    assertions: [
      "A block policy takes precedence over existing allow/ask-first access.",
      "Disabling the block policy takes effect without reconnecting.",
      "Both the denial and later success are audited.",
    ],
  },
  {
    id: "US-5",
    title: "Bring your own MCP server",
    personas: ["Devon"],
    status: "runnable",
    assertions: [
      "A pasted MCP URL discovers fixture tools.",
      "Only reviewed/enabled tools become callable.",
      "Unreviewed tools remain unavailable until the connection is finished.",
    ],
  },
  {
    id: "US-6",
    title: "OAuth connector",
    personas: ["Casey"],
    status: "dependency_gated",
    gate: "Phase 4a/4b Paperclip-owned OAuth app registrations.",
    assertions: [
      "OAuth state round trip completes without token leakage.",
      "Reconnect-after-revoke restores health.",
      "Scoped catalog calls succeed after callback.",
    ],
  },
  {
    id: "US-7",
    title: "External client via gateway",
    personas: ["Devon"],
    status: "dependency_gated",
    gate: "Gateway UI and session revocation dependencies PAP-11200/PAP-11190.",
    assertions: [
      "A real external MCP client sees only policy-allowed tools.",
      "Gateway calls are audited with client/session attribution.",
      "Session revocation cuts the client off immediately.",
    ],
  },
  {
    id: "US-8",
    title: "Credential failure and recovery",
    personas: ["Casey"],
    status: "runnable",
    assertions: [
      "Broken credentials surface on the app card and Needs attention.",
      "Reconnect restores connection health.",
      "Calls succeed after recovery.",
    ],
  },
  {
    id: "US-9",
    title: "Test-tab bug regressions",
    personas: ["Ana"],
    status: "runnable",
    assertions: [
      "A side-effecting ask-first test action can be approved and re-run.",
      "The Review link does not lose the pending card.",
      "Catalog descriptions remain stable for fixture transports.",
    ],
  },
  {
    id: "US-10",
    title: "Admin depth is optional",
    personas: ["Casey", "Ana"],
    status: "runnable",
    assertions: [
      "Casey completes the happy path from Apps.",
      "Ana can trace the same connection in admin depth.",
      "Apps and Tools naming remain coherent.",
    ],
  },
];

export function storyById(id: McpUserStory["id"]): McpUserStory {
  const story = mcpUserStories.find((candidate) => candidate.id === id);
  if (!story) throw new Error(`Unknown MCP user story: ${id}`);
  return story;
}
