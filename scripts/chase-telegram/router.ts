import type { QueryResult } from "./types.ts";
import { escapeHtml } from "./lib/html.ts";
import { classifyIntent, generateReply } from "./lib/llm.ts";
import {
  handleBlockedQuery,
  handleApprovalsQuery,
  handleAgentsQuery,
  handleDetailQuery,
  handleSearchQuery,
  handleOverviewQuery,
  handleAgentIssuesQuery,
} from "./tools/paperclip.ts";
import { handleCreateIssue } from "./tools/actions.ts";
import { handleMetarQuery, handleTafQuery } from "./tools/aviation.ts";

export interface RoutedHandler {
  handler: () => Promise<QueryResult>;
  requiresAi: boolean;
}

// ─── Handler helpers ─────────────────────────────────────────────────

function respond(handler: () => Promise<QueryResult>): RoutedHandler {
  return { handler, requiresAi: false };
}

function respondAi(handler: () => Promise<QueryResult>): RoutedHandler {
  return { handler, requiresAi: true };
}

// ─── Static command handlers ─────────────────────────────────────────

async function handleGreeting(firstName?: string): Promise<QueryResult> {
  const name = firstName ?? "there";
  return {
    text: `Hello, ${escapeHtml(name)}. What can I help you with?`,
  };
}

export async function handleHelp(): Promise<QueryResult> {
  return {
    text: [
      "<b>Available commands</b>",
      "",
      "• <code>/overview</code> — Company overview",
      "• <code>/blocked</code> — Blocked issues",
      "• <code>/approvals</code> — Pending approvals",
      "• <code>/agents</code> — List agents",
      "• <code>/detail &lt;ID&gt;</code> — Issue details (e.g. <code>/detail CRE-123</code>)",
      "• <code>/search &lt;query&gt;</code> — Search issues",
      "• <code>/metar &lt;ICAO&gt;</code> — Current METAR weather (e.g. <code>/metar KJFK</code>)",
      "• <code>/taf &lt;ICAO&gt;</code> — TAF weather forecast (e.g. <code>/taf KJFK</code>)",
      "• <code>/help</code> — This message",
      "",
      "Or just send a question in plain English and I'll route it!",
      "",
      "<i>I'm Chase, the Paperclip-aware AI operations assistant reporting to Christie.</i>",
    ].join("\n"),
  };
}

async function handleStart(): Promise<QueryResult> {
  return {
    text: [
      "<b>Chase here. What do you need from Paperclip?</b>",
      "",
      "I'm the AI operations assistant, reporting to Christie. I can look up blocked issues, pending approvals, agent status, and more.",
      "",
      "Try: <code>/blocked</code>, <code>/overview</code>, <code>/approvals</code>, or <code>/help</code>.",
    ].join("\n"),
  };
}

// ─── Router ───────────────────────────────────────────────────────────

export function routeQuery(
  text: string,
  firstName?: string,
): RoutedHandler {
  const trimmed = text.trim();

  // ── Slash commands (fast path) ──
  if (/^\/(start)\b/i.test(trimmed)) return respond(handleStart);
  if (/^\/(help|commands)\b/i.test(trimmed)) return respond(handleHelp);
  if (/^\/(overview|status|company)\b/i.test(trimmed)) return respond(handleOverviewQuery);
  if (/^\/(blocked|stuck|waiting)\b/i.test(trimmed)) return respond(handleBlockedQuery);
  if (/^\/(approvals|approval|pending)\b/i.test(trimmed)) return respond(handleApprovalsQuery);
  if (/^\/(agents|team|who)\b/i.test(trimmed)) return respond(handleAgentsQuery);

  // ── Slash commands with arguments ──
  const detailMatch = trimmed.match(/^\/detail\s+(.+)/i);
  if (detailMatch) return respond(() => handleDetailQuery(detailMatch[1]!.trim()));

  const searchMatch = trimmed.match(/^\/search\s+(.+)/i);
  if (searchMatch) return respond(() => handleSearchQuery(searchMatch[1]!.trim()));

  const metarMatch = trimmed.match(/^\/metar\s+([A-Za-z0-9]{3,4})\b/i);
  if (metarMatch) return respond(() => handleMetarQuery(metarMatch[1]!.toUpperCase()));

  const tafMatch = trimmed.match(/^\/taf\s+([A-Za-z0-9]{3,4})\b/i);
  if (tafMatch) return respond(() => handleTafQuery(tafMatch[1]!.toUpperCase()));

  // ── Greetings (no API call) ──
  if (/^(hello|hi|hey|yo|sup|good\s*(morning|afternoon|evening)|what'?s\s*up|howdy)\b/i.test(trimmed)) {
    return respond(() => handleGreeting(firstName));
  }
  if (/^chase[,!?.]?$/i.test(trimmed)) return respond(() => handleGreeting(firstName));
  if (/\b(good\s*(morning|afternoon|evening)|howdy)\b/i.test(trimmed)) return respond(() => handleGreeting(firstName));

  // ── Natural language Paperclip queries ──
  if (/what.*blocked|show.*blocked|blocked.*issues?|(?:is\s+)?(?:anything|something)\s+(?:stuck|blocked|waiting)|stuck|waiting.?on/i.test(trimmed)) {
    return respond(handleBlockedQuery);
  }

  if (/pending.*(?:approval|review)|what.*need.*approv|show.*approv|anything\s+(?:need|awaiting|pending)\s+(?:approv|review)/i.test(trimmed)) {
    return respond(handleApprovalsQuery);
  }

  if (!trimmed.startsWith("/") && /who.*(?:agent|team|work(?:ing)?|member)|list.*agent|show.*agent|agents?\b|team\b|roster/i.test(trimmed)) {
    return respond(handleAgentsQuery);
  }

  if (/company.*(?:overview|status)|how.*company|status.*company|how\s+(?:are|is)\s+(?:we|the|everything|things)/i.test(trimmed)) {
    return respond(handleOverviewQuery);
  }

  if (/detail.*(?:issue|CRE|task|ticket)|show.*issue|what.*(?:is|about)\s+(CRE[-\s]?\d+)/i.test(trimmed)) {
    const idMatch = trimmed.match(/CRE[-\s]?\d+/i);
    if (idMatch) {
      const identifier = idMatch[0].replace(/\s+/, "-");
      return respond(() => handleDetailQuery(identifier));
    }
  }

  // "What is X working on?" / agent issues query
  const workingMatch = trimmed.match(
    /(?:what|show|tell)\s+(?:is|are|me)\s+(\w+(?:\s+\w+)?)\s+(?:working\s+on|doing|up\s+to)\b/i,
  );
  if (workingMatch) {
    return respond(() => handleAgentIssuesQuery(workingMatch[1]!));
  }

  // "What's the status of X?"
  const statusAgentMatch = trimmed.match(
    /what(?:'s| is)\s+(?:the\s+)?status\s+(?:of|on)\s+(\w+(?:\s+\w+)?)/i,
  );
  if (statusAgentMatch) {
    return respond(() => handleAgentIssuesQuery(statusAgentMatch[1]!));
  }

  // "How is X doing?"
  const howMatch = trimmed.match(
    /how(?:'s| is)\s+(\w+)\s+(?:doing|going)\b/i,
  );
  if (howMatch && !/company|everything|things|it/i.test(howMatch[1]!)) {
    return respond(() => handleAgentIssuesQuery(howMatch[1]!));
  }

  // "Has X made progress?" / "What has X been working on?"
  const progressMatch = trimmed.match(
    /(?:has|what)\s+(\w+(?:\s+\w+)?)\s+(?:made|been|done)\s+(?:progress|working|up\s+to|lately|recently)/i,
  );
  if (progressMatch) {
    return respond(() => handleAgentIssuesQuery(progressMatch[1]!));
  }

  // ── "Tell me about X" — route to Paperclip query or AI chat ──
  const tellAboutMatch = trimmed.match(
    /tell\s+(?:me|us)\s+about\s+(.+)/i,
  );
  if (tellAboutMatch) {
    const topic = tellAboutMatch[1]!.trim();
    // Check if topic is an agent name
    if (/^(hunter|christie|quinn|hayes|chase|jeff)\b/i.test(topic)) {
      return respond(() => handleAgentIssuesQuery(topic));
    }
    if (/(?:company|overview|status|everything|things?)/i.test(topic)) {
      return respond(handleOverviewQuery);
    }
    if (/(?:block|stuck|waiting)/i.test(topic)) {
      return respond(handleBlockedQuery);
    }
    // Otherwise fall through to LLM
  }

  // ── "What about X?" — single-phrase ──
  const whatAboutMatch = trimmed.match(
    /what\s+about\s+(\w+(?:\s+\w+)?)/i,
  );
  if (whatAboutMatch) {
    const topic = whatAboutMatch[1]!.trim();
    if (/^(hunter|christie|quinn|hayes|chase|jeff)\b/i.test(topic)) {
      return respond(() => handleAgentIssuesQuery(topic));
    }
    // fall through
  }

  // ── Agent action: "have X do Y" / "tell|ask X to do Y" → create issue ──
  // "have" uses bare infinitive; "tell/ask/get" may use "to". Excludes non-agent words.
  const createIssueMatch = trimmed.match(
    /(?:have|tell|ask|get)\s+(?!me|us|them|him|her|it|you|a|an|the|about|what|when|where|why|how)\s*(\w+(?:\s+\w+)?)(?:\s+to\s+|\s+)(.+)/i,
  );
  if (createIssueMatch) {
    const agentName = createIssueMatch[1]!;
    const action = createIssueMatch[2]!;
    return respond(() =>
      handleCreateIssue({
        title: `${agentName}: ${action}`,
        description: action,
        assigneeName: agentName,
      })
    );
  }

  // ── "Create an issue" / "New task" patterns ──
  const newTaskMatch = trimmed.match(
    /(?:create|new|make|open|add)\s+(?:an?\s+)?(?:issue|task|ticket)\s+(?:for|about|to)?\s*(.+)/i,
  );
  if (newTaskMatch) {
    return respond(() =>
      handleCreateIssue({
        title: newTaskMatch[1]!.trim(),
        description: newTaskMatch[1]!.trim(),
      })
    );
  }

  // ── NL weather queries (no AI required) ──
  const nlMetarMatch = trimmed.match(
    /(?:weather\s+(?:at|for)\s+|metar\s+(?:for\s+)?)([A-Za-z0-9]{3,4})\b/i,
  );
  if (nlMetarMatch) return respond(() => handleMetarQuery(nlMetarMatch[1]!.toUpperCase()));

  const nlTafMatch = trimmed.match(
    /(?:forecast\s+(?:at|for)\s+|taf\s+(?:for\s+)?)([A-Za-z0-9]{3,4})\b/i,
  );
  if (nlTafMatch) return respond(() => handleTafQuery(nlTafMatch[1]!.toUpperCase()));

  // ── LLM Intent classification ──
  return respondAi(async () => {
    const intent = await classifyIntent(trimmed);
    if (intent && intent.confidence >= 0.6) {
      switch (intent.intent) {
        case "greeting":
          return handleGreeting(firstName);
        case "paperclip_query": {
          const { agentName, identifier, query } = intent.parameters;
          if (agentName) return handleAgentIssuesQuery(agentName);
          if (identifier) return handleDetailQuery(identifier);
          if (query) {
            const q = query.toLowerCase();
            if (/block|stuck/i.test(q)) return handleBlockedQuery();
            if (/approv|review/i.test(q)) return handleApprovalsQuery();
            if (/agent|team|who|roster/i.test(q)) return handleAgentsQuery();
            if (/overview|status|company/i.test(q)) return handleOverviewQuery();
            return handleSearchQuery(query);
          }
          return handleOverviewQuery();
        }
        case "agent_action": {
          const { agentName, action } = intent.parameters;
          return handleCreateIssue({
            title: action ? `${agentName ? agentName + ": " : ""}${action}` : trimmed,
            description: action ?? trimmed,
            assigneeName: agentName,
          });
        }
        case "aviation_weather": {
          const { station } = intent.parameters;
          if (station) return handleMetarQuery(station);
          break;
        }
        case "web_search":
          return {
            text: "Web search is not yet implemented. Try asking me about Paperclip issues, agents, or use /help to see available commands.",
          };
        default:
          break;
      }
    }
    return { text: await generateReply(trimmed) };
  });
}
