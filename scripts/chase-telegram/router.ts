import type { QueryResult } from "./types.ts";
import { escapeHtml, issueLink } from "./lib/html.ts";
import { classifyIntent, generateReply } from "./lib/llm.ts";
import {
  setUserLocation,
  getUserLocation,
  clearUserLocation,
  formatLocationDisplay,
  getLocationContextString,
} from "./lib/location.ts";
import {
  handleBlockedQuery,
  handleApprovalsQuery,
  handleAgentsQuery,
  handleDetailQuery,
  handleSearchQuery,
  handleOverviewQuery,
  handleAgentIssuesQuery,
} from "./tools/paperclip.ts";
import { resolveAgentByName, handleCreateIssue, lookupIssue, formatActionName } from "./tools/actions.ts";
import { cleanTaskTitle, cleanTaskDescription } from "./tools/cleanup.ts";
import { setPendingTask, getPendingTask, clearPendingTask } from "./lib/pending-tasks.ts";
import { formatTaskPreview, formatAssigneePrompt } from "./tools/preview.ts";
import { handleMetarQuery, handleTafQuery, handleNotamQuery } from "./tools/aviation.ts";
import {
  handleMoviesNearby,
  handleRestaurantsNearby,
  handleHotelsNearby,
  handlePlacesNearby,
} from "./tools/places.ts";
import { handleWebSearch } from "./tools/web_search.ts";

export interface RoutedHandler {
  handler: () => Promise<QueryResult>;
  requiresAi: boolean;
}

function respond(handler: () => Promise<QueryResult>): RoutedHandler {
  return { handler, requiresAi: false };
}

function respondAi(handler: () => Promise<QueryResult>): RoutedHandler {
  return { handler, requiresAi: true };
}

// ─── Venue handler ────────────────────────────────────────────────────

export function routeVenue(
  chatId: number,
  lat: number,
  lon: number,
  title: string,
  address: string,
  firstName?: string,
): () => Promise<QueryResult> {
  setUserLocation(chatId, lat, lon, "venue", { title, address });
  const name = firstName ? `, ${escapeHtml(firstName)}` : "";
  return () => Promise.resolve({
    text: [
      `Location noted${name}! You're at <b>${escapeHtml(title)}</b> — ${escapeHtml(address)}.`,
      "",
      "Want me to find restaurants, movies, or hotels nearby? Just ask!",
    ].join("\n"),
  });
}

// ─── Location message handler ──────────────────────────────────────────

export function routeLocation(
  chatId: number,
  lat: number,
  lon: number,
  text?: string,
  firstName?: string,
): () => Promise<QueryResult> {
  const existing = getUserLocation(chatId);

  setUserLocation(chatId, lat, lon, existing ? "live" : "manual");

  if (text) {
    const q = text.toLowerCase();
    if (/restaurant|food|eat|dinner|lunch|breakfast/i.test(q)) {
      return () => handlePlacesNearby(lat, lon, "restaurant");
    }
    if (/movie|cinema|theat(?:er|re)/i.test(q)) {
      return () => handlePlacesNearby(lat, lon, "cinema");
    }
    if (/hotel|accommodation|lodging|stay/i.test(q)) {
      return () => handlePlacesNearby(lat, lon, "hotel");
    }
    const moviesCmd = text.match(/^\/movies(?:\s+(.+))?/i);
    if (moviesCmd) return () => handlePlacesNearby(lat, lon, "cinema");
    const restaurantsCmd = text.match(/^\/restaurants(?:\s+(.+))?/i);
    if (restaurantsCmd) return () => handlePlacesNearby(lat, lon, "restaurant");
    const hotelsCmd = text.match(/^\/hotels(?:\s+(.+))?/i);
    if (hotelsCmd) return () => handlePlacesNearby(lat, lon, "hotel");
  }

  if (existing) {
    return () => Promise.resolve({
      text: "",
    });
  }
  const name = firstName ? `, ${escapeHtml(firstName)}` : "";
  return () => Promise.resolve({
    text: [
      `Location received${name}! I've noted your coordinates (${formatLocationDisplay({ latitude: lat, longitude: lon, updatedAt: Date.now() })}).`,
      "",
      "Want me to find nearby restaurants, movies, or hotels? Just ask, or share a venue for more context!",
    ].join("\n"),
  });
}

// ─── Static command handlers ─────────────────────────────────────────

async function handleGreeting(firstName?: string): Promise<QueryResult> {
  const responses = firstName
    ? [
        `Hello, ${escapeHtml(firstName)}. What can I help you with?`,
        `Hey, ${escapeHtml(firstName)}! What can I do for you?`,
        `Hi, ${escapeHtml(firstName)}! How can I help you today?`,
        `Good to see you, ${escapeHtml(firstName)}! What do you need?`,
        `Welcome, ${escapeHtml(firstName)}! What can I do for you?`,
      ]
    : [
        "Hello. What can I help you with?",
        "Hey! What can I do for you?",
        "Hi! How can I help you today?",
        "Good to see you! What do you need?",
        "Welcome! What can I do for you?",
      ];
  return {
    text: responses[Math.floor(Math.random() * responses.length)],
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
      "• <code>/notam &lt;ICAO&gt;</code> — NOTAMs for an airport (e.g. <code>/notam KJFK</code>)",
      "• <code>/websearch &lt;query&gt;</code> — Search the internet (e.g. <code>/websearch latest AI news</code>)",
      "• <code>/movies &lt;location&gt;</code> — Find cinemas near a location (e.g. <code>/movies downtown Austin</code>)",
      "• <code>/restaurants &lt;location&gt;</code> — Find restaurants near a location (e.g. <code>/restaurants Brooklyn</code>)",
      "• <code>/hotels &lt;location&gt;</code> — Find hotels near a location (e.g. <code>/hotels Soho London</code>)",
      "• <code>/mylocation</code> — Show your stored location",
      "• <code>/help</code> — This message",
      "",
      "Or just send a question in plain English and I'll route it!",
      "",
      "<i>I'm Chase, the Executive Assistant to Jeff at Paperclip.</i>",
    ].join("\n"),
  };
}

async function handleIdentityQuery(): Promise<QueryResult> {
  return {
    text: "I'm Chase, the Executive Assistant to Jeff at Paperclip. I can look up issues, check blocked work, manage approvals, and more. Try <code>/help</code> to see what I can do.",
  };
}
async function handleStart(): Promise<QueryResult> {
  return {
    text: [
      "<b>Hi! I'm Chase, the Executive Assistant to Jeff at Paperclip.</b>",
      "",
      "I can look up blocked issues, pending approvals, agent status, and more.",
      "",
      "Try: <code>/blocked</code>, <code>/overview</code>, <code>/approvals</code>, or <code>/help</code>.",
    ].join("\n"),
  };
}

async function handleAcknowledgment(firstName?: string): Promise<QueryResult> {
  const name = firstName ? `, ${escapeHtml(firstName)}` : "";
  const responses = [
    `You're welcome${name}! Let me know if you need anything else.`,
    `Happy to help${name}! Anything else I can do?`,
    `Anytime${name}! I'm here when you need me.`,
    `Glad to help${name}! Just say the word if you need more.`,
    `My pleasure${name}! That's what I'm here for.`,
    `Of course${name}! Always happy to assist.`,
    `All set${name}! Let me know what's next.`,
    `You got it${name}! Anything else coming your way?`,
  ];
  return {
    text: responses[Math.floor(Math.random() * responses.length)],
  };
}

// ─── Task creation preview (confirmation flow) ────────────────────────

async function showTaskPreview(
  params: { title: string; description: string; assigneeName?: string; sourceMessage: string },
  chatId: number,
): Promise<QueryResult> {
  let assigneeDisplay: string | undefined;
  if (params.assigneeName) {
    if (params.assigneeName === "UNASSIGNED") {
      assigneeDisplay = "Unassigned";
    } else {
      const resolved = await resolveAgentByName(params.assigneeName);
      if (resolved) {
        assigneeDisplay = resolved.display;
      }
    }
  }

  const cleanedTitle = cleanTaskTitle(params.title, params.assigneeName);
  const cleanedDescription = cleanTaskDescription(params.description);

  setPendingTask(chatId, {
    title: cleanedTitle,
    description: cleanedDescription,
    assigneeName: params.assigneeName,
    sourceMessage: params.sourceMessage,
    createdAt: Date.now(),
    originalDraftTitle:
      cleanedTitle !== params.title ? params.title : undefined,
  });

  return {
    text: formatTaskPreview({
      title: cleanedTitle,
      assigneeDisplay,
      description: cleanedDescription,
    }),
  };
}

// ─── Router ───────────────────────────────────────────────────────────

export function routeQuery(
  text: string,
  firstName?: string,
  chatId?: number,
): RoutedHandler {
  const trimmed = text.trim();

  // ── Pending task confirmation check ──
  if (chatId) {
    const pending = getPendingTask(chatId);
    if (pending) {
      // Check expiration (30 minute timeout)
      if (Date.now() - pending.createdAt > 30 * 60 * 1000) {
        clearPendingTask(chatId);
        return respond(async () => ({
          text: "Your pending task preview has expired. Please send your request again.",
        }));
      }

      // ── Awaiting assignee: user must name an agent or say UNASSIGNED ──
      if (pending.awaitingAssign) {
        if (/^UNASSIGNED$/i.test(trimmed)) {
          const cleanedTitle = cleanTaskTitle(pending.title, "UNASSIGNED");
          const cleanedDescription = cleanTaskDescription(pending.description);
          setPendingTask(chatId, {
            ...pending,
            assigneeName: "UNASSIGNED",
            title: cleanedTitle,
            description: cleanedDescription,
            awaitingAssign: false,
          });
          return respond(async () => ({
            text: formatTaskPreview({
              title: cleanedTitle,
              assigneeDisplay: "Unassigned",
              description: cleanedDescription,
            }),
          }));
        }

        // Cancel
        if (/^(?:no|nope|nah|cancel(?:\s+it)?|stop|never\s+mind|forget(?:\s+it)?|dismiss|not\s+now|ignore|back)\b/i.test(trimmed)) {
          return respond(async () => {
            clearPendingTask(chatId);
            return { text: "Cancelled. Let me know if you need anything else." };
          });
        }

        // Try resolving as an agent name
        return respond(async () => {
          const pending = getPendingTask(chatId);
          if (!pending) return { text: "No pending task." };
          const resolved = await resolveAgentByName(trimmed);
          if (resolved) {
            const cleanedTitle = cleanTaskTitle(pending.title, resolved.display);
            const cleanedDescription = cleanTaskDescription(pending.description);
            setPendingTask(chatId, {
              ...pending,
              assigneeName: resolved.display,
              title: cleanedTitle,
              description: cleanedDescription,
              awaitingAssign: false,
            });
            return {
              text: formatTaskPreview({
                title: cleanedTitle,
                assigneeDisplay: resolved.display,
                description: cleanedDescription,
              }),
            };
          }
          return {
            text: "I didn't understand that. Reply with an agent name (e.g. <b>Hunter</b>), or reply <b>UNASSIGNED</b> to create the task without an assignee.",
          };
        });
      }

      // ── Standard confirmation check ──
      // Explicit confirmation phrases
      if (/^(?:yes|yeah|yep|create(?:\s+it)?|approved|go\s+ahead|do\s+it|proceed|confirm)\b/i.test(trimmed)) {
        return respond(async () => {
          const result = await handleCreateIssue({
            title: pending.title,
            description: pending.description,
            assigneeName: pending.assigneeName,
            sourceMessage: pending.sourceMessage,
            confirmationMessage: trimmed,
            chatId,
            originalDraftTitle: pending.originalDraftTitle,
            sourceIssueId: pending.sourceIssueId,
            sourceIssueIdentifier: pending.sourceIssueIdentifier,
          });
          return result;
        });
      }

      // Cancel phrases
      if (/^(?:no|nope|nah|cancel(?:\s+it)?|stop|never\s+mind|forget(?:\s+it)?|dismiss|not\s+now|ignore|back)\b/i.test(trimmed)) {
        return respond(async () => {
          clearPendingTask(chatId);
          return { text: "Cancelled. Let me know if you need anything else." };
        });
      }

      // Vague/non-confirmation while pending: don't create, just remind
      if (/^(?:ok|okay|thanks?|sure\??|maybe|sounds?\s+good|got\s+it|understood|roger|copy|fine|alright)[.!]*$/i.test(trimmed)) {
        return respond(async () => ({
          text: "I need a clear confirmation. Reply <b>YES</b> to create the task, or <b>CANCEL</b> to cancel it.",
        }));
      }

      // Catch-all: anything else while pending — don't fall through to normal routing
      return respond(async () => ({
        text: "You have a pending task that needs your decision first. Reply <b>YES</b> to create it, or <b>CANCEL</b> to cancel it.",
      }));
    }
  }

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

  const notamMatch = trimmed.match(/^\/notam\s+([A-Za-z0-9]{3,4})\b/i);
  if (notamMatch) return respond(() => handleNotamQuery(notamMatch[1]!.toUpperCase()));

  const webSearchMatch = trimmed.match(/^\/websearch\s+(.+)/i);
  if (webSearchMatch) return respond(() => handleWebSearch(webSearchMatch[1]!.trim()));

  const moviesMatch = trimmed.match(/^\/movies\s+(.+)/i);
  if (moviesMatch) return respond(() => handleMoviesNearby(moviesMatch[1]!.trim()));

  const restaurantsMatch = trimmed.match(/^\/restaurants\s+(.+)/i);
  if (restaurantsMatch) return respond(() => handleRestaurantsNearby(restaurantsMatch[1]!.trim()));

  const hotelsMatch = trimmed.match(/^\/hotels\s+(.+)/i);
  if (hotelsMatch) return respond(() => handleHotelsNearby(hotelsMatch[1]!.trim()));

  // ── /mylocation command ──
  if (/^\/mylocation\b/i.test(trimmed)) {
    return respond(async () => {
      const loc = chatId ? getUserLocation(chatId) : undefined;
      if (!loc) {
        return {
          text: "I don't know your location yet. Share it with me using Telegram's attachment/location feature and I'll remember it!",
        };
      }
      return {
        text: [
          `<b>Your current location:</b>`,
          `Coordinates: ${formatLocationDisplay(loc)}`,
          loc.venueTitle ? `Venue: ${escapeHtml(loc.venueTitle)}${loc.venueAddress ? ` — ${escapeHtml(loc.venueAddress)}` : ""}` : null,
          "",
          "Want me to find nearby restaurants, movies, or hotels? Just ask!",
        ].filter(Boolean).join("\n"),
      };
    });
  }

  // ── "near me" patterns (use stored location if available) ──
  const nearMeMatch = trimmed.match(
    /(?:restaurants?|food|eat|dinner|lunch|breakfast|movies?|cinemas?|theat(?:er|re)s?|hotels?|accommodation|lodging|stay|places?\s+to\s+eat|places?\s+to\s+stay)\s+(?:near|around)\s+me/i,
  );
  if (nearMeMatch) {
    const loc = chatId ? getUserLocation(chatId) : undefined;
    if (loc) {
      return respond(async () => {
        const q = trimmed.toLowerCase();
        if (/restaurant|food|eat|dinner|lunch|breakfast/i.test(q)) {
          return handlePlacesNearby(loc.latitude, loc.longitude, "restaurant");
        }
        if (/movie|cinema|theat(?:er|re)/i.test(q)) {
          return handlePlacesNearby(loc.latitude, loc.longitude, "cinema");
        }
        if (/hotel|accommodation|lodging|stay/i.test(q)) {
          return handlePlacesNearby(loc.latitude, loc.longitude, "hotel");
        }
        return handlePlacesNearby(loc.latitude, loc.longitude, "restaurant");
      });
    }
    return respondAi(async () => {
      return {
        text: "To find places near your current location, please share your location using Telegram's attachment/location feature.",
      };
    });
  }

  // ── Greetings (no API call) ──
  if (/^(hello|hi|hey|yo|sup|good\s*(morning|afternoon|evening)|what'?s\s*up|howdy)\b/i.test(trimmed)) {
    return respond(() => handleGreeting(firstName));
  }
  if (/^chase[,!?.]?$/i.test(trimmed)) return respond(() => handleGreeting(firstName));
  if (/\b(good\s*(morning|afternoon|evening)|howdy)\b/i.test(trimmed)) return respond(() => handleGreeting(firstName));

  // ── Identity questions (fast path) ──
  if (/^(?:who|what)(?:'s| is| are)\s+(?:you|chase|this\s+bot)/i.test(trimmed)) {
    return respond(handleIdentityQuery);
  }

  // ── Social acknowledgments (fast path, no API call) ──
  if (/^(?:thanks?|thank you|ty|thx|appreciate (?:it|that)|ok(?:ay)?|sure|alright|roger(?: that)?|copy(?: that)?|wilco|10[-\s]?4|got it|gotcha|understood|i see|makes? sense|nice|great|cool|awesome|perfect|excellent)[.!]*$/i.test(trimmed)) {
    return respond(() => handleAcknowledgment(firstName));
  }
  if (/^(?:nice|great|awesome|cool|perfect|excellent|sounds?\s+good|looks?\s+good|that'?s?\s+great)[,!. ]+\s+(?:thanks?|thank you|ty|thx)\b/i.test(trimmed)) {
    return respond(() => handleAcknowledgment(firstName));
  }

  // ── Bare number → issue detail (fast path) ──
  if (/^\d+$/.test(trimmed)) {
    return respond(() => handleDetailQuery(trimmed));
  }
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

  // Strip leading conversational filler words for task-related patterns
  const fillerStripped = trimmed.replace(
    /^(?:yeah\s*,?\s*|yes\s*,?\s*|yep\s*,?\s*|okay\s*,?\s*|ok\s*,?\s*|sure\s*,?\s*|sure\s+thing\s*,?\s*|please\s*,?\s*|so\s*,?\s*)\s*/i,
    "",
  );

  // ── Destructive/state-changing action on a specific issue ──
  // Patterns: "Can you delete CRE-549?", "Delete CRE-549", "Mark CRE-549 done", etc.
  const destructiveActionPattern =
    /^(?:(?:can\s+you\s*|please\s*))?(?:delete|close|cancel|remove|archive|mark\s+done)\s+(?:task\s+|issue\s+)?(CRE[-\s]?\d+|\d+)\b/i;
  const destructiveActionMatch = trimmed.match(destructiveActionPattern) || fillerStripped.match(destructiveActionPattern);
  if (destructiveActionMatch && chatId) {
    const rawAction = destructiveActionMatch[0].toLowerCase();
    const rawIdentifier = destructiveActionMatch[2] ?? destructiveActionMatch[1]!;
    const identifier = rawIdentifier.toUpperCase().replace(/\s+/, "-");
    let action = "delete";
    if (/close/.test(rawAction)) action = "close";
    else if (/cancel/.test(rawAction)) action = "cancel";
    else if (/remove/.test(rawAction)) action = "remove";
    else if (/archive/.test(rawAction)) action = "archive";
    else if (/mark\s+done/.test(rawAction)) action = "mark_done";
    return respond(async () => {
      const issue = await lookupIssue(identifier).catch(() => null);
      const actionName = formatActionName(action);
      if (!issue) {
        return { text: `I couldn't find issue ${identifier}. Please check the identifier and try again.` };
      }
      setPendingTask(chatId, {
        title: `${actionName} ${issue.identifier}`,
        description: `${actionName} ${issue.identifier} - ${issue.title}. Requested by Jeff via Telegram.`,
        sourceMessage: trimmed,
        createdAt: Date.now(),
        awaitingAssign: true,
        destructiveAction: action,
        sourceIssueId: issue.id,
        sourceIssueIdentifier: issue.identifier,
      });
      return {
        text: [
          `I can help with that. Here\u2019s what I found:`,
          ``,
          `<b>${issueLink(issue.identifier)} \u2014 ${escapeHtml(issue.title)}</b>`,
          `Status: <code>${issue.status}</code> | Priority: <code>${issue.priority}</code>`,
          ``,
          `<b>Proposed action:</b> ${actionName} ${issue.identifier}`,
          `<b>Reason:</b> Jeff requested via Telegram.`,
          ``,
          `Reply with an agent name (e.g. <b>Miles</b>), or <b>CANCEL</b> to cancel.`,
        ].join("\n"),
      };
    });
  }

  // ── "Can you have X do Y" — indirect task delegation (preview with confirmation) ──
  // Must come BEFORE the capability check since it starts with "Can you have..."
  // Also check filler-stripped version for "Yeah can you have..."
  const canYouHaveText = trimmed.match(/^can\s+you\s+(?:have|ask|tell|get)\s/i)
    ? trimmed
    : fillerStripped.match(/^can\s+you\s+(?:have|ask|tell|get)\s/i)
    ? fillerStripped
    : null;
  const canYouHaveMatch = (canYouHaveText || trimmed).match(
    /^can\s+you\s+(?:have|ask|tell|get)\s+(\w+)(?:\s+to\s+|\s+)(.+)/i,
  );
  if (canYouHaveMatch && chatId) {
    const agentName = canYouHaveMatch[1]!;
    const action = canYouHaveMatch[2]!;
    return respond(() =>
      showTaskPreview({
        title: `${agentName}: ${action}`,
        description: action,
        assigneeName: agentName,
        sourceMessage: trimmed,
      }, chatId)
    );
  }

  // ── Questions about Chase's own capabilities (route to AI chat, NEVER create issues) ──
  // Catches: "Do you have Internet access?", "Can you search the web?", "What can you do?"
  // Also catches: "So do you now have Internet or AI access?" (starts with "So")
  // Excludes task delegations like "Can you have X do Y" (caught above).
  // These must NEVER reach issue creation paths.
  const capabilityPatterns = [
    /(?:do|does)\s+(?:you|chase)\s+(?:\w+\s+)*(?:have|know|see|get|access|use|remember|store)\s/i,
    /(?:can|could)\s+(?:you|chase)\s+(?:\w+\s+)*(?:have|access|search|see|find|use|remember|store|book)\s/i,
    /what\s+(?:can|does|do)\s+(?:you|chase)\s+(?:\w+\s+)*(?:do|have|access)\b/i,
    /(?:are)\s+(?:you|chase)\s+(?:\w+\s+)*(?:able|capable)\s+/i,
    /what\s+(?:are)\s+(?:you|chase)\s+(?:\w+\s+)*(?:capable\s+of|able\s+to\s+do)/i,
  ];
  if (capabilityPatterns.some(p => p.test(trimmed))) {
    return respondAi(async () => {
      const locCtx = chatId ? getLocationContextString(chatId) : null;
      return { text: await generateReply(trimmed, locCtx ?? undefined) };
    });
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

  // ── Agent action: "have X do Y" / "tell|ask X to do Y" → preview with confirmation ──
  // "have" uses bare infinitive; "tell/ask/get" may use "to". Excludes non-agent words.
  // ANCHORED to start of string to avoid matching "have" as an auxiliary verb in questions.
  // Check both original and filler-stripped text for leading filler support.
  const createIssueText = /^(?:have|tell|ask|get)\s/i.test(trimmed)
    ? trimmed
    : /^(?:have|tell|ask|get)\s/i.test(fillerStripped)
    ? fillerStripped
    : null;
  const createIssueMatch = (createIssueText || trimmed).match(
    /^(?:have|tell|ask|get)\s+(?!me|us|them|him|her|it|you|a|an|the|about|what|when|where|why|how)\s*(\w+)(?:\s+to\s+|\s+)(.+)/i,
  );
  if (createIssueMatch && chatId) {
    const agentName = createIssueMatch[1]!;
    const action = createIssueMatch[2]!;
    return respond(() =>
      showTaskPreview({
        title: `${agentName}: ${action}`,
        description: action,
        assigneeName: agentName,
        sourceMessage: trimmed,
      }, chatId)
    );
  }

  // ── "Create an issue" / "New task" patterns (require assignee) ──
  const newTaskMatch = trimmed.match(
    /(?:create|new|make|open|add)\s+(?:an?\s+)?(?:issue|task|ticket)\s+(?:for|about|to)?\s*(.+)/i,
  );
  if (newTaskMatch && chatId) {
    const desc = newTaskMatch[1]!.trim();
    return respond(async () => {
      setPendingTask(chatId, {
        title: desc,
        description: desc,
        sourceMessage: trimmed,
        createdAt: Date.now(),
        awaitingAssign: true,
      });
      return {
        text: formatAssigneePrompt({ title: desc, description: desc }),
      };
    });
  }

  // ── NL places queries (no AI required) ──
  const nlMoviesMatch = trimmed.match(
    /(?:movies?|cinemas?|theat(?:er|re)s?)\s+(?:near|in|around|close\s+to)\s+(.+)/i,
  );
  if (nlMoviesMatch) return respond(() => handleMoviesNearby(nlMoviesMatch[1]!.trim()));

  const nlRestaurantsMatch = trimmed.match(
    /(?:restaurants?|food|places?\s+to\s+eat|dinner|lunch|breakfast)\s+(?:near|in|around|close\s+to)\s+(.+)/i,
  );
  if (nlRestaurantsMatch) return respond(() => handleRestaurantsNearby(nlRestaurantsMatch[1]!.trim()));

  const nlHotelsMatch = trimmed.match(
    /(?:hotels?|accommodation|lodging|places?\s+to\s+stay)\s+(?:near|in|around|close\s+to)\s+(.+)/i,
  );
  if (nlHotelsMatch) return respond(() => handleHotelsNearby(nlHotelsMatch[1]!.trim()));

  // ── NL weather queries (no AI required) ──
  const nlMetarMatch = trimmed.match(
    /(?:weather\s+(?:at|for)\s+|metar\s+(?:for\s+)?)([A-Za-z0-9]{3,4})\b/i,
  );
  if (nlMetarMatch) return respond(() => handleMetarQuery(nlMetarMatch[1]!.toUpperCase()));

  const nlTafMatch = trimmed.match(
    /(?:forecast\s+(?:at|for)\s+|taf\s+(?:for\s+)?)([A-Za-z0-9]{3,4})\b/i,
  );
  if (nlTafMatch) return respond(() => handleTafQuery(nlTafMatch[1]!.toUpperCase()));

  const nlNotamMatch = trimmed.match(
    /(?:notams?\s+(?:at|for)\s+|notam\s+(?:for\s+)?)([A-Za-z0-9]{3,4})\b/i,
  );
  if (nlNotamMatch) return respond(() => handleNotamQuery(nlNotamMatch[1]!.toUpperCase()));

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
          // Safety check: if the LLM couldn't identify any agent and the message
          // is a casual question, this is almost certainly a false positive.
          // Route to chat instead of creating an orphan issue.
          if (!agentName && /^(?:do|does|can|could|will|would|are|is)\s/i.test(trimmed)) {
            const locCtx = chatId ? getLocationContextString(chatId) : null;
            return { text: await generateReply(trimmed, locCtx ?? undefined) };
          }
          if (!agentName) {
            return { text: "I'd be happy to create that task, but I need to know who it's for.\n\nTry something like:\n<code>Have [agent name] [task description]</code>\n\nFor example: \"Have Hunter review the PR\" or \"Ask Christie to update the docs.\"" };
          }
          const rawTitle = action
            ? `${agentName ? agentName + ": " : ""}${action}`
            : trimmed;
          if (!chatId) {
            return handleCreateIssue({
              title: cleanTaskTitle(rawTitle, agentName),
              description: cleanTaskDescription(action ?? trimmed),
              assigneeName: agentName,
              originalDraftTitle: cleanTaskTitle(rawTitle, agentName) !== rawTitle ? rawTitle : undefined,
            });
          }
          return showTaskPreview({
            title: rawTitle,
            description: action ?? trimmed,
            assigneeName: agentName,
            sourceMessage: trimmed,
          }, chatId);
        }
        case "aviation_weather": {
          const { station } = intent.parameters;
          if (station) {
            if (/notam/i.test(trimmed)) return handleNotamQuery(station);
            if (/taf/i.test(trimmed)) return handleTafQuery(station);
            return handleMetarQuery(station);
          }
          break;
        }
        case "location_search": {
          const { query: locQuery } = intent.parameters;
          if (locQuery) {
            const q = locQuery.toLowerCase();
            if (/restaurant|food|eat|dinner|lunch|breakfast/i.test(q)) {
              return handleRestaurantsNearby(locQuery.replace(/(?:restaurants?|food|eat|dinner|lunch|breakfast)\s+(?:near|in|around)\s+/i, "").trim());
            }
            if (/hotel|accommodation|lodging|stay/i.test(q)) {
              return handleHotelsNearby(locQuery.replace(/(?:hotels?|accommodation|lodging|stay)\s+(?:near|in|around)\s+/i, "").trim());
            }
            if (/movie|cinema|theat(?:er|re)/i.test(q)) {
              return handleMoviesNearby(locQuery.replace(/(?:movies?|cinemas?|theat(?:er|re)s?)\s+(?:near|in|around)\s+/i, "").trim());
            }
            return handleRestaurantsNearby(locQuery);
          }
          break;
        }
        case "web_search": {
          const { query } = intent.parameters;
          if (query) return handleWebSearch(query);
          return handleWebSearch(trimmed);
        }
        default:
          break;
      }
    }
    const locCtx = chatId ? getLocationContextString(chatId) : null;
    return { text: await generateReply(trimmed, locCtx ?? undefined) };
  });
}