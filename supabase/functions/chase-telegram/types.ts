export interface TelegramLocation {
  latitude: number;
  longitude: number;
  live_period?: number;
  heading?: number;
}

export interface TelegramVenue {
  location: TelegramLocation;
  title: string;
  address: string;
  foursquare_id?: string;
  foursquare_type?: string;
  google_place_id?: string;
  google_place_type?: string;
}

export interface StoredLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
  venueTitle?: string;
  venueAddress?: string;
}

export type LocationSource = "manual" | "venue" | "live";

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name?: string; username?: string };
  message?: {
    message_id: number;
    chat: { id: number; type: string };
  };
  data: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    location?: TelegramLocation;
    venue?: TelegramVenue;
    date: number;
  };
  callback_query?: TelegramCallbackQuery;
}

export interface PaperclipAgent {
  id: string;
  name: string;
  role?: string;
  title?: string;
  status?: string;
}

export interface PaperclipIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId?: string | null;
  description?: string;
  blockedBy?: Array<{ id: string; identifier: string; title?: string; status: string }>;
  blocks?: Array<{ id: string; identifier: string; title?: string; status: string }>;
}

export interface PaperclipApproval {
  id: string;
  title: string;
  summary?: string;
  status: string;
  type: string;
  payload?: { title?: string; summary?: string; recommendedAction?: string };
}

export interface PaperclipActivity {
  id: string;
  action: string;
  entityType?: string;
  createdAt: string;
  actorType?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface QueryResult {
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMChoice {
  message: { content: string };
}

export interface LLMResponse {
  choices: LLMChoice[];
}

// ─── Telegram Bot Commands ──────────────────────────────────────────

export interface BotCommand {
  command: string;
  description: string;
}

export const CHASE_COMMANDS: BotCommand[] = [
  { command: "help", description: "What Chase can do" },
  { command: "commands", description: "Show shortcut commands" },
  { command: "about", description: "What Chase is" },
  { command: "ping", description: "Bot health check" },
  { command: "version", description: "Current deployed version" },
  { command: "overview", description: "Company overview" },
  { command: "status", description: "Paperclip system status" },
  { command: "blocked", description: "Blocked issues" },
  { command: "approvals", description: "Pending approvals" },
  { command: "agents", description: "List agents" },
  { command: "detail", description: "Issue details" },
  { command: "search", description: "Search issues" },
  { command: "spend", description: "Monthly spend and budget" },
  { command: "recent", description: "Recent completed work" },
];

export type Intent =
  | "greeting"
  | "paperclip_query"
  | "agent_action"
  | "aviation_weather"
  | "location_search"
  | "web_search"
  | "chat"
  | "unknown";

export interface IntentResult {
  intent: Intent;
  confidence: number;
  parameters: {
    identifier?: string;
    query?: string;
    agentName?: string;
    action?: string;
    station?: string;
  };
}
