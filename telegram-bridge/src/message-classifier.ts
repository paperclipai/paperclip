/**
 * Message classifier — determines whether an inbound Telegram message
 * should create a Paperclip issue or be handled as a quick conversation.
 *
 * Four categories:
 *   - "conversational" — quick Qs, acknowledgments, chitchat. No issue needed.
 *     The bridge answers directly via a lightweight LLM call.
 *   - "task" — needs tracked work, multi-step, or agent tools. Creates a
 *     Paperclip issue as before.
 *   - "ephemeral" — needs Karl's tools but shouldn't pollute the board.
 *     Creates an issue with originKind="interactive" that auto-closes.
 *   - "content_capture" — link shares, article URLs, pasted text. Handled
 *     bridge-side: fetch content, classify, write to vault inbox. No
 *     Paperclip issue is created.
 *
 * Evaluation order: content_capture → task → ephemeral → conversational.
 * Content capture is checked first because a URL with no task verb is
 * capture, not a task.
 */

export type MessageIntent = "conversational" | "task" | "ephemeral" | "content_capture";

export type ClassificationResult = {
  intent: MessageIntent;
  /** Human-readable reason for the classification (for logging). */
  reason: string;
  /** Confidence 0-1. Below 0.5, fall through to "task" for safety. */
  confidence: number;
};

// ---------------------------------------------------------------------------
// Content capture signals — checked FIRST because URLs without task verbs
// are captures, not tasks
// ---------------------------------------------------------------------------

const CONTENT_CAPTURE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(?:capture|file|clip|stash)\s+(?:this|that|it|link|article|note|message)\b/i, reason: "explicit capture intent" },
  { pattern: /\b(?:capture|save|file|clip|stash)\b.{0,60}\b(?:inbox|vault|second.?brain|read later|for later)\b/i, reason: "capture to inbox/vault" },
  { pattern: /\b(?:add|put)\s+(?:(?:this|that|it)(?:\s+(?:link|article|note|message))?|link|article|note|message)\s+(?:to|into)\s+(?:the\s+)?(?:inbox|vault|second.?brain|notes?)\b/i, reason: "save to inbox/vault" },
  // Social media post URLs (Twitter/X, LinkedIn, Reddit, Hacker News)
  { pattern: /https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/i, reason: "tweet URL" },
  { pattern: /https?:\/\/(www\.)?linkedin\.com\/(posts|feed)\//i, reason: "LinkedIn URL" },
  { pattern: /https?:\/\/(www\.)?reddit\.com\/r\//i, reason: "Reddit URL" },
  { pattern: /https?:\/\/news\.ycombinator\.com/i, reason: "Hacker News URL" },
  // Article/blog URLs
  { pattern: /https?:\/\/\S+\/\d{4}\/\d{2}\//i, reason: "dated article URL" },
  { pattern: /https?:\/\/(medium\.com|substack\.com|bsky\.app|threads\.net)\/\S+/i, reason: "blog/social URL" },
  // Generic URL with no task context — bare URL share
  { pattern: /^https?:\/\/\S+$/m, reason: "bare URL share" },
  // YouTube/video shares
  { pattern: /https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/\S+/i, reason: "YouTube URL" },
];

// Task verbs that disqualify a message from being content capture
// "Read this article and summarize it" is a task, not a capture
const TASK_DISQUALIFYING_PATTERNS = [
  /\b(?:create|build|fix|refactor|migrate|implement|deploy|configure|set\s+up|install|write|draft|design|review|audit|debug|investigate|research|analyze|compare|summarize|explain|translate)\b/i,
  /\b(?:then\s+(?:also|after|once)|after\s+that|next\s+(?:step|thing))\b/i,
];

// ---------------------------------------------------------------------------
// Task signals — checked AFTER content capture
// ---------------------------------------------------------------------------

const TASK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Explicit task verbs
  { pattern: /\b(?:create|build|fix|refactor|migrate|implement|deploy|configure|set\s+up|install|write|draft|design|review|audit|debug|investigate|research|analyze|compare)\b/i, reason: "task verb" },
  // Multi-step connectors
  { pattern: /\b(?:then\s+(?:also|after|once)|after\s+that|next\s+(?:step|thing)|also\s+(?:need|want|create))\b/i, reason: "multi-step" },
  // Delegation / dispatch language
  { pattern: /\b(?:dispatch|delegate|assign|ask\s+(?:q|caro|don|shauna|blake|phil|apollo|dalio))\b/i, reason: "delegation" },
  // File/code references
  { pattern: /\b(?:\.ts|\.js|\.py|\.md|\.yaml|\.json|v2\/|tests\/|src\/)\b/, reason: "code/file reference" },
];

// ---------------------------------------------------------------------------
// Conversational signals — messages that clearly don't need tracked work
// ---------------------------------------------------------------------------

const CONVERSATIONAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Greetings / farewells / acknowledgments
  { pattern: /^(?:hi|hey|hello|yo|sup|morning|evening|good\s*(?:morning|evening|night)|thanks|thx|ty|ok|okay|got\s*it|sounds\s*good|will\s*do|cool|nice|great|awesome|perfect|sweet|lol|haha|👍|🙏|✅|💯)\b/i, reason: "greeting/acknowledgment" },
  // Simple yes/no
  { pattern: /^(?:yes|no|yep|nope|yeah|nah|sure|maybe|probably)\b/i, reason: "yes/no response" },
  // Quick time/date/weather questions (answerable without tools)
  { pattern: /^(?:what\s+time|what\s+day|what\s+date|what's\s+the\s+(?:time|date|day)|how\s+late\s+is\s+it)\b/i, reason: "time/date question" },
  // "You there?" / status check
  { pattern: /^(?:you\s+there|you\s+around|you\s+alive|you\s+up|are\s+you\s+(?:there|around|alive|up))\b/i, reason: "status check" },
  // Conversational filler that starts with common chitchat
  { pattern: /^(?:how\s+are\s+you|what'?s\s+up|how'?s\s+it\s+going|how\s+you\s+doing)\b/i, reason: "chitchat" },
  // Very short messages with no question or imperative (< 15 chars, no ?!)
  // Checked AFTER task patterns so "fix the bug" doesn't get caught here
  { pattern: /^[^.?!]{0,14}$/, reason: "very short non-question" },
  // Short strings with no alphanumeric content (emoji, symbols)
  { pattern: /^[^\w]{1,10}$/, reason: "emoji-only" },
];

// ---------------------------------------------------------------------------
// Tool signals — words that imply the agent needs tools to answer
// ---------------------------------------------------------------------------

const TOOL_SIGNAL_WORDS = /\b(?:emails?|calendar|schedule|inbox|slack|github|issues?|prs?|merge|hubspot|deals?|pipeline|vault|second.?brain|memory|notes?|tasks?|crons?)\b/i;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify an inbound Telegram message to determine how it should be handled.
 *
 * Returns "conversational" for quick exchanges that don't need a Paperclip
 * issue, "task" for work that needs tracked issues, or "ephemeral" for
 * messages that need Karl's tools but shouldn't create board clutter.
 */
export function classifyMessage(text: string | undefined): ClassificationResult {
  const cleaned = (text ?? "").trim();

  // Empty or whitespace-only — treat as conversational (likely a voice/photo
  // that was already transcribed but ended up empty)
  if (cleaned.length === 0) {
    return { intent: "conversational", reason: "empty message", confidence: 0.9 };
  }

  // 0. Check content capture FIRST — URLs without task verbs are captures
  for (const { pattern, reason } of CONTENT_CAPTURE_PATTERNS) {
    if (pattern.test(cleaned)) {
      // But if there are task verbs alongside the URL, it's a task, not a capture
      const hasTaskVerb = TASK_DISQUALIFYING_PATTERNS.some(p => p.test(cleaned));
      if (hasTaskVerb) {
        return { intent: "task", reason: `URL with task verb (${reason})`, confidence: 0.8 };
      }
      return { intent: "content_capture", reason, confidence: 0.85 };
    }
  }

  // 1. Check task patterns — these are the most specific signals
  for (const { pattern, reason } of TASK_PATTERNS) {
    if (pattern.test(cleaned)) {
      return { intent: "task", reason, confidence: 0.8 };
    }
  }

  // Length heuristic: long messages are almost always tasks
  if (cleaned.length > 200) {
    return { intent: "task", reason: "long message (>200 chars)", confidence: 0.7 };
  }

  // 2. Check conversational patterns — strong signals for non-task messages
  for (const { pattern, reason } of CONVERSATIONAL_PATTERNS) {
    if (pattern.test(cleaned)) {
      return { intent: "conversational", reason, confidence: 0.85 };
    }
  }

  // 3. Questions → check tool signals BEFORE short-question shortcut
  if (/\?\s*$/.test(cleaned)) {
    if (TOOL_SIGNAL_WORDS.test(cleaned)) {
      return { intent: "ephemeral", reason: "question needing agent tools", confidence: 0.7 };
    }
    // Short single-sentence question (< 80 chars) without tool signals — conversational
    if (cleaned.length < 80) {
      return { intent: "conversational", reason: "short question", confidence: 0.6 };
    }
    // Longer question without tool signals — ephemeral
    return { intent: "ephemeral", reason: "generic question", confidence: 0.55 };
  }

  // 4. Imperative statements (check X, send Y, find Z) → ephemeral
  if (/^(?:please\s+)?(?:can\s+you\s+)?(?:check|tell|send|look|find|get|pull|read|search)\b/i.test(cleaned)) {
    return { intent: "ephemeral", reason: "imperative needing tools", confidence: 0.65 };
  }

  // Default: fall through to task. It's safer to create an issue for
  // ambiguous messages than to silently swallow them.
  return { intent: "task", reason: "unclassified — defaulting to task", confidence: 0.3 };
}
