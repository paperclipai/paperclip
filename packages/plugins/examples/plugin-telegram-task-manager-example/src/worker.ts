/**
 * Telegram Task Manager - Paperclip Plugin Worker
 *
 * Навигация бота построена вокруг inline-кнопок и редактирования одного
 * dashboard-сообщения, чтобы не засорять чат новыми сообщениями.
 */
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import TelegramBot from "node-telegram-bot-api";
import manifest from "./manifest.js";
import {
  formatCommentTimestamp as formatLocalizedCommentTimestamp,
  formatCommentAddedNotice,
  formatCommentsButton,
  formatCompanyAlreadySelectedNotice,
  formatCompanySwitchedNotice,
  formatNewCommentNotification,
  formatPageSummary,
  formatPriority as formatLocalizedPriority,
  formatResetNotice,
  formatTaskAlreadyAssignedNotice,
  formatTaskCreatedNotice,
  formatTaskCreatedNotification,
  formatIssueReferenceText as formatLocalizedIssueReferenceText,
  formatTaskNotFoundByReference,
  formatTaskReassignedNotice,
  formatStatus as formatLocalizedStatus,
  formatUserDisplayLabel as formatLocalizedUserDisplayLabel,
  formatAgentTasksHeading,
  formatBotInitializedLine,
  formatCommentPageSummary,
  getBotCommands,
  getIssueTitle as getLocalizedIssueTitle,
  normalizeLanguage,
  projectSortLocale,
  t as translate,
  type SupportedLanguage,
} from "./i18n.js";

type BotIssue = {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string | null;
  projectId?: string | null;
  project?: BotProject | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

type BotIssueComment = {
  id: string;
  issueId: string;
  body: string;
  authorAgentId?: string;
  authorUserId?: string;
  createdAt: Date | string;
  updatedAt?: Date | string;
};

type BotAgent = {
  id: string;
  name: string;
  role?: string;
};

type BotProject = {
  id: string;
  name: string;
  status?: string;
  archivedAt?: Date | string | null;
};

type BotCompany = {
  id: string;
  name: string;
};

type TaskListState = {
  kind: "agent" | "recent";
  page: number;
  agentId?: string;
  agentName?: string;
};

type SessionState = {
  chatId: string;
  lastMessageAt: string;
  dashboardMessageId?: number;
  selectedAgentId?: string;
  selectedAgentName?: string;
  selectedTaskId?: string;
  currentScreen?:
    | "home"
    | "agents"
    | "recent"
    | "tasks"
    | "task"
    | "comments"
    | "status"
    | "help"
    | "taskProject"
    | "taskAgent"
    | "companies";
  agentsPage?: number;
  lastTaskList?: TaskListState;
  pendingCommentTaskId?: string;
  pendingCommentPromptMessageId?: number;
  pendingCommentReturnScreen?: "task" | "comments";
  pendingTaskAgentId?: string;
  pendingTaskAgentName?: string;
  pendingTaskProjectId?: string | null;
  pendingTaskProjectName?: string;
  pendingTaskPromptMessageId?: number;
  pendingTaskDraftTitle?: string;
  pendingTaskDraftDescription?: string;
};

type NormalizedConfig = {
  language?: SupportedLanguage;
  telegramBotToken?: string;
  telegramChatId?: string;
  allowedTelegramUserId?: string;
};

type SanitizedConfigResult = {
  changed: boolean;
  config: Record<string, unknown>;
};

type LocalBoardCredentials = {
  apiBase: string;
  token: string;
  userId?: string;
};

type RenderOptions = {
  preferredMessageId?: number;
  notice?: string;
};

const sessions = new Map<string, SessionState>();
const LAST_CHAT_ID_STATE_KEY = "last-authorized-chat-id";
const SELECTED_COMPANY_STATE_KEY = "selected-company-id";
const AGENTS_PAGE_SIZE = 6;
const TASKS_PAGE_SIZE = 6;
const PROJECTS_PAGE_SIZE = 6;
const COMMENTS_PAGE_SIZE = 1;
const ISSUE_STATUS_STATE_NAMESPACE = "issue-status";
const ISSUE_REOPEN_STATUS_STATE_NAMESPACE = "issue-reopen-status";
const ACTIVE_ISSUE_STATUSES = new Set(["backlog", "todo", "open", "in_progress"]);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled", "canceled"]);
const ALLOWED_CONFIG_KEYS = new Set(["language", "telegramBotToken", "telegramChatId", "allowedTelegramUserId"]);
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let bot: TelegramBot | null = null;
let currentCompanyId: string | null = null;
let notificationChatId: string | null = null;
let cachedLocalBoardCredentials: LocalBoardCredentials | null | undefined;
let activeConfig: NormalizedConfig = {};
let language: SupportedLanguage = "ru";

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeConfig(rawConfig: Record<string, unknown>): NormalizedConfig {
  return {
    language: normalizeLanguage(rawConfig.language),
    telegramBotToken: asNonEmptyString(rawConfig.telegramBotToken),
    telegramChatId: asNonEmptyString(rawConfig.telegramChatId),
    allowedTelegramUserId: asNonEmptyString(rawConfig.allowedTelegramUserId),
  };
}

function sanitizeStoredConfig(rawConfig: Record<string, unknown>): SanitizedConfigResult {
  const config: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawConfig)) {
    if (ALLOWED_CONFIG_KEYS.has(key)) {
      config[key] = value;
    }
  }

  return {
    changed:
      Object.keys(config).length !== Object.keys(rawConfig).length ||
      Object.keys(rawConfig).some((key) => !ALLOWED_CONFIG_KEYS.has(key)),
    config,
  };
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncate(input: string | undefined, maxLength: number): string {
  const value = (input ?? "").trim();
  if (!value) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function clampPage(page: number, totalItems: number, pageSize: number): number {
  const maxPage = Math.max(0, Math.ceil(totalItems / pageSize) - 1);
  return Math.min(Math.max(page, 0), maxPage);
}

function getIssueIdentifier(issue: Pick<BotIssue, "identifier">): string | undefined {
  return asNonEmptyString(issue.identifier);
}

function getIssueTitle(issue: Pick<BotIssue, "title">, language: SupportedLanguage = "ru"): string {
  return getLocalizedIssueTitle(asNonEmptyString(issue.title) ?? "", language);
}

function formatIssueDisplayName(
  issue: Pick<BotIssue, "identifier" | "title">,
  maxTitleLength = 0,
  language: SupportedLanguage = "ru",
): string {
  const identifier = getIssueIdentifier(issue);
  const title = maxTitleLength > 0 ? truncate(getIssueTitle(issue, language), maxTitleLength) : getIssueTitle(issue, language);
  return identifier ? `${identifier} — ${title}` : title;
}

function formatIssueListLine(
  issue: Pick<BotIssue, "identifier" | "title">,
  maxTitleLength: number,
  language: SupportedLanguage = "ru",
): string {
  const identifier = getIssueIdentifier(issue);
  const title = escapeHtml(truncate(getIssueTitle(issue, language), maxTitleLength));
  if (!identifier) {
    return `<b>${title}</b>`;
  }

  return `<b>${escapeHtml(identifier)}</b> — ${title}`;
}

function formatIssueButtonLabel(
  issue: Pick<BotIssue, "identifier" | "title">,
  identifierMaxLength = 18,
  titleMaxLength = 18,
  language: SupportedLanguage = "ru",
): string {
  const identifier = getIssueIdentifier(issue);
  const title = truncate(getIssueTitle(issue, language), titleMaxLength);
  return identifier ? `${truncate(identifier, identifierMaxLength)} · ${title}` : title;
}

function formatIssueReferenceText(
  issue: Pick<BotIssue, "identifier" | "title">,
  language: SupportedLanguage = "ru",
): string {
  return formatLocalizedIssueReferenceText(getIssueIdentifier(issue), issue.title, language, truncate);
}

function buildIssueHeadingLines(
  issue: Pick<BotIssue, "identifier" | "title">,
  language: SupportedLanguage = "ru",
): string[] {
  const identifier = getIssueIdentifier(issue);
  const title = getIssueTitle(issue, language);
  if (!identifier) {
    return [`<b>${escapeHtml(title)}</b>`];
  }

  return [`<b>${escapeHtml(identifier)}</b>`, escapeHtml(title)];
}

function formatUserDisplayLabel(
  userId: string,
  currentUserId: string | undefined,
  language: SupportedLanguage = "ru",
): string {
  return formatLocalizedUserDisplayLabel(userId, currentUserId, language);
}

function statusEmoji(status: string | undefined): string {
  switch (status) {
    case "todo":
    case "open":
    case "backlog":
      return "🟡";
    case "in_progress":
      return "🔵";
    case "blocked":
      return "⛔";
    case "done":
    case "closed":
      return "✅";
    case "canceled":
    case "cancelled":
      return "⚪";
    default:
      return "•";
  }
}

function priorityEmoji(priority: string | undefined): string {
  switch (priority) {
    case "critical":
      return "🚨";
    case "high":
      return "🔺";
    case "medium":
      return "🔸";
    case "low":
      return "▫️";
    default:
      return "•";
  }
}

function formatStatus(status: string | undefined, language: SupportedLanguage = "ru"): string {
  return formatLocalizedStatus(status, language);
}

function formatPriority(priority: string | undefined, language: SupportedLanguage = "ru"): string {
  return formatLocalizedPriority(priority, language);
}

function normalizeIssueStatus(status: string | undefined | null): string | null {
  const value = asNonEmptyString(status);
  return value ? value.toLowerCase() : null;
}

function shouldReopenOnCommentReply(status: string | undefined): boolean {
  const normalizedStatus = normalizeIssueStatus(status);
  return Boolean(normalizedStatus && !ACTIVE_ISSUE_STATUSES.has(normalizedStatus));
}

function normalizeIssueReopenStatus(status: string | undefined): string | null {
  const normalizedStatus = normalizeIssueStatus(status);
  switch (normalizedStatus) {
    case "todo":
    case "blocked":
    case "in_review":
      return "in_progress";
    case "backlog":
    case "open":
    case "in_progress":
      return normalizedStatus;
    default:
      return null;
  }
}

function sortCommentsByNewest(comments: BotIssueComment[]): BotIssueComment[] {
  return [...comments].sort((left, right) => {
    const leftTime = new Date(left.createdAt || left.updatedAt || "").getTime();
    const rightTime = new Date(right.createdAt || right.updatedAt || "").getTime();
    return rightTime - leftTime;
  });
}

function toTimestamp(value: Date | string | undefined | null): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseTaskDraft(input: string): { title: string; description: string } | null {
  const normalized = input.replace(/\r\n/g, "\n");
  const [rawTitle = "", ...descriptionLines] = normalized.split("\n");
  const title = rawTitle.trim();
  if (!title) {
    return null;
  }

  return {
    title,
    description: descriptionLines.join("\n").trim(),
  };
}

function sortProjectsByName(projects: BotProject[], language: SupportedLanguage = "ru"): BotProject[] {
  return [...projects].sort((left, right) => left.name.localeCompare(right.name, projectSortLocale(language)));
}

function buildPageButtons(
  currentPage: number,
  totalItems: number,
  pageSize: number,
  previousCallbackData: string,
  nextCallbackData: string,
) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (totalPages <= 1) {
    return undefined;
  }

  const row = [];

  if (currentPage > 0) {
    row.push({ text: "⬅️", callback_data: previousCallbackData });
  }

  row.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: "noop" });

  if (currentPage < totalPages - 1) {
    row.push({ text: "➡️", callback_data: nextCallbackData });
  }

  return row;
}

async function stopBot(): Promise<void> {
  if (!bot) {
    return;
  }

  const activeBot = bot;
  bot = null;
  activeBot.removeAllListeners();

  try {
    await activeBot.stopPolling();
  } catch {
    // Polling may already be stopped.
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("🚀 Telegram Task Manager starting...");
    cachedLocalBoardCredentials = undefined;

    const rawConfig = await ctx.config.get();
    activeConfig = normalizeConfig(rawConfig);
    const config = activeConfig;
    language = config.language ?? "ru";
    const botCommands = getBotCommands(language);
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate(language, key, params);

    currentCompanyId = null;
    notificationChatId = config.telegramChatId ?? null;

    if (!notificationChatId) {
      const persistedChatId = await ctx.state.get({
        scopeKind: "instance",
        stateKey: LAST_CHAT_ID_STATE_KEY,
      });
      notificationChatId = asNonEmptyString(persistedChatId) ?? null;
    }

    const rememberChatId = async (chatId: string) => {
      notificationChatId = chatId;
      await ctx.state.set({ scopeKind: "instance", stateKey: LAST_CHAT_ID_STATE_KEY }, chatId);
    };

    const pruneSessions = () => {
      const cutoff = Date.now() - MAX_SESSION_AGE_MS;
      for (const [chatId, session] of sessions.entries()) {
        const timestamp = new Date(session.lastMessageAt).getTime();
        if (!Number.isFinite(timestamp) || timestamp < cutoff) {
          sessions.delete(chatId);
        }
      }
    };

    const upsertSession = (chatId: string, patch: Partial<SessionState> = {}): SessionState => {
      pruneSessions();
      const nextSession: SessionState = {
        chatId,
        lastMessageAt: new Date().toISOString(),
        ...(sessions.get(chatId) ?? {}),
        ...patch,
      };
      sessions.set(chatId, nextSession);
      return nextSession;
    };

    const clearPendingComment = (chatId: string) => {
      upsertSession(chatId, {
        pendingCommentTaskId: undefined,
        pendingCommentPromptMessageId: undefined,
        pendingCommentReturnScreen: undefined,
      });
    };

    const clearPendingTaskCreation = (chatId: string) => {
      upsertSession(chatId, {
        pendingTaskAgentId: undefined,
        pendingTaskAgentName: undefined,
        pendingTaskProjectId: undefined,
        pendingTaskProjectName: undefined,
        pendingTaskPromptMessageId: undefined,
        pendingTaskDraftTitle: undefined,
        pendingTaskDraftDescription: undefined,
      });
    };

    const clearCompanyScopedSelections = (chatId: string) => {
      clearPendingComment(chatId);
      clearPendingTaskCreation(chatId);
      upsertSession(chatId, {
        selectedAgentId: undefined,
        selectedAgentName: undefined,
        selectedTaskId: undefined,
        lastTaskList: undefined,
      });
    };

    const clearAllCompanyScopedSelections = () => {
      for (const chatId of sessions.keys()) {
        clearCompanyScopedSelections(chatId);
      }
    };

    const agentNameCache = new Map<string, string>();
    const projectNameCache = new Map<string, string>();
    const companyNameCache = new Map<string, string>();
    const userLabelCache = new Map<string, string>();

    const rememberAgentName = (agent: BotAgent | null | undefined): string | null => {
      const name = asNonEmptyString(agent?.name);
      const id = asNonEmptyString(agent?.id);
      if (!id || !name) {
        return null;
      }

      agentNameCache.set(id, name);
      return name;
    };

    const rememberProjectName = (project: BotProject | null | undefined): string | null => {
      const name = asNonEmptyString(project?.name);
      const id = asNonEmptyString(project?.id);
      if (!id || !name) {
        return null;
      }

      projectNameCache.set(id, name);
      return name;
    };

    const rememberCompanyName = (company: BotCompany | null | undefined): string | null => {
      const name = asNonEmptyString(company?.name);
      const id = asNonEmptyString(company?.id);
      if (!id || !name) {
        return null;
      }

      companyNameCache.set(id, name);
      return name;
    };

    const sendTelegramNotification = async (
      text: string,
      options?: TelegramBot.SendMessageOptions,
    ): Promise<void> => {
      if (!notificationChatId || !bot) {
        return;
      }

      await bot.sendMessage(notificationChatId, text, options);
    };

    const issueStatusStateScope = (issueId: string) => ({
      scopeKind: "instance" as const,
      namespace: ISSUE_STATUS_STATE_NAMESPACE,
      stateKey: issueId,
    });

    const issueReopenStatusStateScope = (issueId: string) => ({
      scopeKind: "instance" as const,
      namespace: ISSUE_REOPEN_STATUS_STATE_NAMESPACE,
      stateKey: issueId,
    });

    const readIssueStatus = async (issueId: string): Promise<string | null> => {
      const rawStatus = await ctx.state.get(issueStatusStateScope(issueId));
      return typeof rawStatus === "string" ? normalizeIssueStatus(rawStatus) : null;
    };

    const readIssueReopenStatus = async (issueId: string): Promise<string | null> => {
      const rawStatus = await ctx.state.get(issueReopenStatusStateScope(issueId));
      return typeof rawStatus === "string" ? normalizeIssueStatus(rawStatus) : null;
    };

    const rememberIssueReopenStatus = async (issueId: string, status: string | undefined): Promise<void> => {
      const normalizedStatus = normalizeIssueReopenStatus(status);
      if (!normalizedStatus) {
        return;
      }

      await ctx.state.set(issueReopenStatusStateScope(issueId), normalizedStatus);
    };

    const rememberIssueStatus = async (issueId: string, status: string | undefined): Promise<void> => {
      const normalizedStatus = normalizeIssueStatus(status);
      if (!normalizedStatus) {
        await ctx.state.delete(issueStatusStateScope(issueId));
        await ctx.state.delete(issueReopenStatusStateScope(issueId));
        return;
      }

      await ctx.state.set(issueStatusStateScope(issueId), normalizedStatus);
      if (!TERMINAL_ISSUE_STATUSES.has(normalizedStatus)) {
        await rememberIssueReopenStatus(issueId, normalizedStatus);
      }
    };

    const rememberIssueStatuses = async (issues: BotIssue[]): Promise<void> => {
      await Promise.all(
        issues.map((issue) => {
          return rememberIssueStatus(issue.id, issue.status);
        }),
      );
    };

    const sortIssuesByRecentCommentActivity = async (
      issues: BotIssue[],
      companyId: string,
    ): Promise<BotIssue[]> => {
      const issueActivity = await Promise.all(
        issues.map(async (issue) => {
          try {
            const comments = sortCommentsByNewest(
              (await ctx.issues.listComments(issue.id, companyId)) as BotIssueComment[],
            );
            const latestComment = comments[0];
            const activityAt =
              toTimestamp(latestComment?.createdAt ?? latestComment?.updatedAt) ||
              toTimestamp(issue.updatedAt) ||
              toTimestamp(issue.createdAt);

            return { issue, activityAt };
          } catch (error) {
            ctx.logger.warn("Failed to load comments while sorting recent tasks", {
              error,
              issueId: issue.id,
            });
            return {
              issue,
              activityAt: toTimestamp(issue.updatedAt) || toTimestamp(issue.createdAt),
            };
          }
        }),
      );

      return issueActivity
        .sort((left, right) => right.activityAt - left.activityAt)
        .map((entry) => entry.issue);
    };

    const listActiveProjects = async (companyId: string): Promise<BotProject[]> => {
      const projects = (await ctx.projects.list({
        companyId,
        limit: 200,
      })) as BotProject[];

      const activeProjects = sortProjectsByName(projects.filter((project) => !project.archivedAt), language);
      for (const project of activeProjects) {
        rememberProjectName(project);
      }

      return activeProjects;
    };

    const seedRecentIssueStatuses = async (companyId: string): Promise<void> => {
      try {
        const recentIssues = (await ctx.issues.list({
          companyId,
          limit: 200,
        })) as BotIssue[];
        await rememberIssueStatuses(recentIssues);
        ctx.logger.info("Seeded issue status state", { count: recentIssues.length, companyId });
      } catch (error) {
        ctx.logger.warn("Failed to seed issue status state", { error, companyId });
      }
    };

    const notifyIfIssueBlocked = async (issue: BotIssue, previousStatus: string | null): Promise<void> => {
      const currentStatus = normalizeIssueStatus(issue.status);
      if (currentStatus !== "blocked" || !previousStatus || previousStatus === "blocked") {
        return;
      }

      try {
        const headingLines = buildIssueHeadingLines(issue, language);
        await sendTelegramNotification(
          [
            t("blocked_notification_heading"),
            ...headingLines,
            "",
            `<b>${t("was_label")}:</b> ${escapeHtml(formatStatus(previousStatus, language))}`,
            `<b>${t("now_label")}:</b> ${statusEmoji(issue.status)} ${escapeHtml(formatStatus(issue.status, language))}`,
          ].join("\n"),
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[{ text: t("open_task"), callback_data: `task:${issue.id}` }]],
            },
          },
        );
      } catch (error) {
        ctx.logger.error("Failed to send blocked issue notification", {
          error,
          issueId: issue.id,
          previousStatus,
        });
      }
    };

    const resolveLocalBoardCredentials = async (): Promise<LocalBoardCredentials | null> => {
      if (cachedLocalBoardCredentials !== undefined) {
        return cachedLocalBoardCredentials;
      }

      const authFilePath = join(process.env.HOME ?? homedir(), ".paperclip", "auth.json");

      try {
        const authFile = JSON.parse(await readFile(authFilePath, "utf8")) as {
          credentials?: Record<
            string,
            {
              apiBase?: unknown;
              token?: unknown;
              userId?: unknown;
            }
          >;
        };
        const credentials = Object.values(authFile.credentials ?? {});
        const selectedCredential = credentials.find((credential) => {
          return asNonEmptyString(credential?.apiBase) && asNonEmptyString(credential?.token);
        });

        if (!selectedCredential) {
          cachedLocalBoardCredentials = null;
          return null;
        }

        cachedLocalBoardCredentials = {
          apiBase: asNonEmptyString(selectedCredential.apiBase)!,
          token: asNonEmptyString(selectedCredential.token)!,
          userId: asNonEmptyString(selectedCredential.userId),
        };
        return cachedLocalBoardCredentials;
      } catch (error) {
        ctx.logger.warn("Failed to load local Paperclip auth for Telegram board API bridge", {
          error,
          authFilePath,
        });
        cachedLocalBoardCredentials = null;
        return null;
      }
    };

    const callLocalBoardApi = async <T>(
      path: string,
      init: {
        method: "GET" | "POST" | "PATCH";
        body?: unknown;
      },
    ): Promise<T> => {
      const credentials = await resolveLocalBoardCredentials();
      if (!credentials) {
        throw new Error("Local Paperclip board auth not found");
      }

      const response = await fetch(new URL(path, credentials.apiBase), {
        method: init.method,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });

      if (!response.ok) {
        const errorText = (await response.text()).slice(0, 600);
        throw new Error(`Board API ${init.method} ${path} failed: ${response.status} ${errorText}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    };

    const persistSanitizedPluginConfig = async (nextConfig: Record<string, unknown>): Promise<void> => {
      await callLocalBoardApi(`/api/plugins/${manifest.id}/config`, {
        method: "POST",
        body: {
          configJson: nextConfig,
        },
      });
    };

    const resolveReopenStatusForIssue = async (issue: BotIssue): Promise<string> => {
      const preferredStatus = await readIssueReopenStatus(issue.id);
      if (preferredStatus === "in_progress" && !issue.assigneeAgentId && !issue.assigneeUserId) {
        return "backlog";
      }

      if (preferredStatus) {
        return preferredStatus;
      }

      return issue.assigneeAgentId || issue.assigneeUserId ? "in_progress" : "backlog";
    };

    const reopenIssueViaBoardApi = async (issue: BotIssue): Promise<BotIssue> => {
      const reopenStatus = await resolveReopenStatusForIssue(issue);
      const updatedIssue = await callLocalBoardApi<BotIssue>(`/api/issues/${issue.id}`, {
        method: "PATCH",
        body: {
          status: reopenStatus,
        },
      });
      await rememberIssueStatus(updatedIssue.id, updatedIssue.status);
      return updatedIssue;
    };

    const addIssueCommentViaBoardApi = async (
      issueId: string,
      commentText: string,
    ): Promise<BotIssueComment> => {
      return await callLocalBoardApi<BotIssueComment>(`/api/issues/${issueId}/comments`, {
        method: "POST",
        body: {
          body: commentText,
        },
      });
    };

    const listCompanies = async (): Promise<BotCompany[]> => {
      const companies = await callLocalBoardApi<BotCompany[]>("/api/companies", {
        method: "GET",
      });

      return companies.filter((company) => {
        return Boolean(asNonEmptyString(company.id) && asNonEmptyString(company.name));
      });
    };

    const persistSelectedCompanyId = async (companyId: string | null): Promise<void> => {
      currentCompanyId = companyId;

      if (companyId) {
        await ctx.state.set({ scopeKind: "instance", stateKey: SELECTED_COMPANY_STATE_KEY }, companyId);
        await seedRecentIssueStatuses(companyId);
        return;
      }

      await ctx.state.delete({ scopeKind: "instance", stateKey: SELECTED_COMPANY_STATE_KEY });
    };

    const initializeSelectedCompany = async (): Promise<string | null> => {
      if (currentCompanyId) {
        return currentCompanyId;
      }

      const companies = await listCompanies();
      if (companies.length === 0) {
        return null;
      }

      const persistedCompanyId = asNonEmptyString(
        await ctx.state.get({ scopeKind: "instance", stateKey: SELECTED_COMPANY_STATE_KEY }),
      );
      const selectedCompany =
        companies.find((company) => company.id === persistedCompanyId) ??
        companies.find((company) => asNonEmptyString(company.id)) ??
        null;

      if (!selectedCompany?.id) {
        return null;
      }

      rememberCompanyName(selectedCompany);
      await persistSelectedCompanyId(selectedCompany.id);
      return selectedCompany.id;
    };

    const switchCurrentCompany = async (companyId: string): Promise<{ changed: boolean; companyName: string | null }> => {
      const normalizedCompanyId = asNonEmptyString(companyId);
      if (!normalizedCompanyId) {
        return { changed: false, companyName: null };
      }

      const companies = await listCompanies();
      const selectedCompany = companies.find((company) => company.id === normalizedCompanyId) ?? null;
      if (!selectedCompany) {
        throw new Error(`Company ${normalizedCompanyId} is not available`);
      }

      const companyName = rememberCompanyName(selectedCompany);
      const changed = currentCompanyId !== normalizedCompanyId;

      if (changed) {
        clearAllCompanyScopedSelections();
      }

      await persistSelectedCompanyId(normalizedCompanyId);
      return { changed, companyName };
    };

    const resolveAgentName = async (companyId: string, agentId: string | undefined): Promise<string | null> => {
      const normalizedAgentId = asNonEmptyString(agentId);
      if (!normalizedAgentId) {
        return null;
      }

      const cachedName = agentNameCache.get(normalizedAgentId);
      if (cachedName) {
        return cachedName;
      }

      const agent = (await ctx.agents.get(normalizedAgentId, companyId)) as BotAgent | null;
      return rememberAgentName(agent);
    };

    const resolveProjectName = async (
      companyId: string,
      projectId: string | null | undefined,
    ): Promise<string | null> => {
      const normalizedProjectId = asNonEmptyString(projectId);
      if (!normalizedProjectId) {
        return null;
      }

      const cachedName = projectNameCache.get(normalizedProjectId);
      if (cachedName) {
        return cachedName;
      }

      const project = (await ctx.projects.get(normalizedProjectId, companyId)) as BotProject | null;
      return rememberProjectName(project);
    };

    const resolveCompanyName = async (companyId: string | null | undefined): Promise<string | null> => {
      const normalizedCompanyId = asNonEmptyString(companyId);
      if (!normalizedCompanyId) {
        return null;
      }

      const cachedName = companyNameCache.get(normalizedCompanyId);
      if (cachedName) {
        return cachedName;
      }

      try {
        const company = await callLocalBoardApi<BotCompany>(`/api/companies/${normalizedCompanyId}`, {
          method: "GET",
        });
        return rememberCompanyName(company);
      } catch (error) {
        ctx.logger.warn("Failed to resolve company name", { error, companyId: normalizedCompanyId });
        return null;
      }
    };

    const resolveUserLabel = async (userId: string | undefined): Promise<string | null> => {
      const normalizedUserId = asNonEmptyString(userId);
      if (!normalizedUserId) {
        return null;
      }

      const cachedLabel = userLabelCache.get(normalizedUserId);
      if (cachedLabel) {
        return cachedLabel;
      }

      const credentials = await resolveLocalBoardCredentials();
      const label = formatUserDisplayLabel(normalizedUserId, credentials?.userId, language);
      userLabelCache.set(normalizedUserId, label);
      return label;
    };

    const resolveIssueAssigneeLabel = async (
      issue: Pick<BotIssue, "assigneeAgentId" | "assigneeUserId">,
      companyId: string,
      preferredAgentName?: string,
    ): Promise<string> => {
      if (issue.assigneeAgentId) {
        return preferredAgentName ?? (await resolveAgentName(companyId, issue.assigneeAgentId)) ?? t("generic_agent");
      }

      if (issue.assigneeUserId) {
        return (await resolveUserLabel(issue.assigneeUserId)) ?? t("generic_user");
      }

      return t("unassigned");
    };

    const resolveCommentAuthorLabel = async (
      comment: BotIssueComment,
      companyId: string,
    ): Promise<string> => {
      if (comment.authorAgentId) {
        return (await resolveAgentName(companyId, comment.authorAgentId)) ?? t("generic_agent");
      }

      if (comment.authorUserId) {
        return (await resolveUserLabel(comment.authorUserId)) ?? t("generic_user");
      }

      return t("generic_author");
    };

    const resolveSelectedTaskName = async (chatId: string): Promise<string> => {
      const session = sessions.get(chatId);
      if (!session?.selectedTaskId || !currentCompanyId) {
        return t("not_selected");
      }

      try {
        const issue = (await ctx.issues.get(session.selectedTaskId, currentCompanyId)) as BotIssue | null;
        return issue ? formatIssueDisplayName(issue, 52, language) : t("not_selected");
      } catch (error) {
        ctx.logger.warn("Failed to resolve selected task name", {
          error,
          chatId,
          issueId: session.selectedTaskId,
        });
        return t("not_selected");
      }
    };

    const isAllowedTelegramUser = (userId: number | undefined): boolean => {
      if (!activeConfig.allowedTelegramUserId) {
        return true;
      }

      return String(userId ?? "") === activeConfig.allowedTelegramUserId;
    };

    const ensureAuthorizedChat = async (chatId: string, userId: number | undefined): Promise<boolean> => {
      if (isAllowedTelegramUser(userId)) {
        return true;
      }

      await bot?.sendMessage(chatId, t("unauthorized_user"));
      return false;
    };

    const ensureAuthorizedCallback = async (
      callbackQueryId: string,
      userId: number | undefined,
    ): Promise<boolean> => {
      if (isAllowedTelegramUser(userId)) {
        return true;
      }

      await bot?.answerCallbackQuery(callbackQueryId, {
        text: t("access_denied"),
        show_alert: true,
      });
      return false;
    };

    const ensureCompanyId = async (chatId: string): Promise<string | null> => {
      try {
        const companyId = await initializeSelectedCompany();
        if (companyId) {
          return companyId;
        }
      } catch (error) {
        ctx.logger.error("Failed to initialize selected company", { error });
      }

      await bot?.sendMessage(chatId, t("no_available_organizations"));
      return null;
    };

    const renderDashboard = async (
      chatId: string,
      text: string,
      inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>,
      options: RenderOptions = {},
    ): Promise<void> => {
      if (!bot) {
        return;
      }

      const session = upsertSession(chatId);
      const targetMessageId = options.preferredMessageId ?? session.dashboardMessageId;
      const messageText = options.notice
        ? `ℹ️ <i>${escapeHtml(options.notice)}</i>\n\n${text}`
        : text;

      if (targetMessageId) {
        try {
          await bot.editMessageText(messageText, {
            chat_id: chatId,
            message_id: targetMessageId,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: inlineKeyboard },
          });

          upsertSession(chatId, { dashboardMessageId: targetMessageId });
          return;
        } catch (error) {
          const message = String((error as Error)?.message ?? "");
          if (!message.includes("message is not modified")) {
            ctx.logger.warn("Failed to edit dashboard message, sending a new one", { error });
          } else {
            upsertSession(chatId, { dashboardMessageId: targetMessageId });
            return;
          }
        }
      }

      const sent = await bot.sendMessage(chatId, messageText, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: inlineKeyboard },
      });

      upsertSession(chatId, { dashboardMessageId: sent.message_id });
    };

    const resetDashboard = async (chatId: string, dashboardMessageId?: number): Promise<void> => {
      if (!bot) {
        return;
      }

      const currentDashboardMessageId = dashboardMessageId ?? sessions.get(chatId)?.dashboardMessageId;
      if (typeof currentDashboardMessageId === "number") {
        try {
          await bot.deleteMessage(chatId, currentDashboardMessageId);
        } catch (error) {
          ctx.logger.warn("Failed to delete dashboard message before reset", {
            error,
            chatId,
            dashboardMessageId: currentDashboardMessageId,
          });
        }
      }

      upsertSession(chatId, { dashboardMessageId: undefined });
      await renderHome(chatId, {
        notice: formatResetNotice(language),
      });
    };

    const renderHome = async (chatId: string, options: RenderOptions = {}) => {
      const session = upsertSession(chatId, { currentScreen: "home" });
      await initializeSelectedCompany();
      const selectedTaskName = await resolveSelectedTaskName(chatId);
      const companyName = await resolveCompanyName(currentCompanyId);
      const companyDisplayName = currentCompanyId
        ? companyName ?? t("could_not_resolve")
        : t("not_configured");
      const notificationsStatus = notificationChatId ? t("notifications_enabled") : t("notifications_not_configured");

      const lines = [
        "<b>Telegram Task Manager</b>",
        "",
        `<b>${t("organization_label")}:</b> ${escapeHtml(companyDisplayName)}`,
        `<b>${t("notifications_label")}:</b> ${escapeHtml(notificationsStatus)}`,
        `<b>${t("agent_label")}:</b> ${escapeHtml(session.selectedAgentName ?? t("assignee_not_selected"))}`,
        `<b>${t("task_label")}:</b> ${escapeHtml(selectedTaskName)}`,
      ];

      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
        [{ text: t("organizations"), callback_data: "companies" }],
        [
          { text: t("agents"), callback_data: "agents:0" },
          { text: t("recent_tasks"), callback_data: "recent:0" },
        ],
      ];

      if (session.selectedAgentId) {
        keyboard.push([{
          text: t("selected_agent_tasks"),
          callback_data: "mytasks",
        }]);
        keyboard.push([{ text: t("new_task"), callback_data: `newtask:${session.selectedAgentId}` }]);
      }

      if (session.selectedTaskId) {
        keyboard.push([{
          text: t("open_current_task"),
          callback_data: `task:${session.selectedTaskId}`,
        }]);
      }

      keyboard.push([
        { text: t("status"), callback_data: "status" },
        { text: t("help"), callback_data: "help" },
      ]);

      keyboard.push([{ text: t("reset_screen"), callback_data: "reset" }]);

      await renderDashboard(chatId, lines.join("\n"), keyboard, options);
    };

    const renderCompanies = async (chatId: string, options: RenderOptions = {}) => {
      upsertSession(chatId, { currentScreen: "companies" });

      const companies = await listCompanies();
      if (companies.length === 0) {
        await renderDashboard(
          chatId,
          t("organizations_empty"),
          [[{ text: t("home"), callback_data: "home" }]],
          options,
        );
        return;
      }

      const activeCompanyId = await initializeSelectedCompany();
      const lines = [
        t("organizations_title"),
        "",
        t("organizations_choose"),
      ];
      const keyboard = companies.map((company) => {
        const isActive = company.id === activeCompanyId;
        return [
          {
            text: `${isActive ? "✅ " : ""}${truncate(company.name, 48)}`,
            callback_data: `company:${company.id}`,
          },
        ];
      });

      keyboard.push([{ text: t("home"), callback_data: "home" }]);

      await renderDashboard(chatId, lines.join("\n"), keyboard, options);
    };

    const renderStatus = async (chatId: string, options: RenderOptions = {}) => {
      upsertSession(chatId, { currentScreen: "status" });
      await initializeSelectedCompany();
      const companyName = await resolveCompanyName(currentCompanyId);
      const companyDisplayName = currentCompanyId
        ? companyName ?? t("could_not_resolve")
        : t("not_configured");
      const notificationsStatus = notificationChatId ? t("notifications_linked") : t("notifications_not_configured");
      const accessStatus = activeConfig.allowedTelegramUserId
        ? t("access_restricted")
        : t("access_unrestricted");

      const lines = [
        t("status_title"),
        "",
        formatBotInitializedLine(language, Boolean(bot)),
        `<b>${t("organization_label")}:</b> ${escapeHtml(companyDisplayName)}`,
        `<b>${t("notifications_label")}:</b> ${escapeHtml(notificationsStatus)}`,
        `<b>${t("access_label")}:</b> ${escapeHtml(accessStatus)}`,
      ];

      await renderDashboard(
        chatId,
        lines.join("\n"),
        [
          [{ text: t("organizations"), callback_data: "companies" }],
          [
            { text: t("home"), callback_data: "home" },
            { text: t("help"), callback_data: "help" },
          ],
        ],
        options,
      );
    };

    const renderHelp = async (chatId: string, options: RenderOptions = {}) => {
      upsertSession(chatId, { currentScreen: "help" });

      const lines = t("help_text").split("\n");

      await renderDashboard(
        chatId,
        lines.join("\n"),
        [
          [
            { text: t("home"), callback_data: "home" },
            { text: t("agents"), callback_data: "agents:0" },
          ],
        ],
        options,
      );
    };

    const renderAgents = async (chatId: string, page = 0, options: RenderOptions = {}) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const agents = (await ctx.agents.list({ companyId })) as BotAgent[];
      for (const agent of agents) {
        rememberAgentName(agent);
      }
      if (agents.length === 0) {
        await renderDashboard(
          chatId,
          t("agents_empty"),
          [[{ text: t("home"), callback_data: "home" }]],
          options,
        );
        return;
      }

      const safePage = clampPage(page, agents.length, AGENTS_PAGE_SIZE);
      const session = upsertSession(chatId, {
        currentScreen: "agents",
        agentsPage: safePage,
      });

      const start = safePage * AGENTS_PAGE_SIZE;
      const pageAgents = agents.slice(start, start + AGENTS_PAGE_SIZE);

      const lines = [
        t("agents_title"),
        "",
        formatPageSummary(language, start + 1, Math.min(start + pageAgents.length, agents.length), agents.length),
        "",
        t("choose_agent"),
      ];

      const agentButtons = pageAgents.map((agent) => ({
        text: `${session.selectedAgentId === agent.id ? "✅ " : ""}${truncate(agent.name, 28)}`,
        callback_data: `agent:${agent.id}:${safePage}`,
      }));

      const keyboard = agentButtons.map((button) => [button]);

      const pagination = buildPageButtons(
        safePage,
        agents.length,
        AGENTS_PAGE_SIZE,
        `agents:${safePage - 1}`,
        `agents:${safePage + 1}`,
      );
      if (pagination) {
        keyboard.push(pagination);
      }

      keyboard.push([{ text: t("home"), callback_data: "home" }]);

      await renderDashboard(chatId, lines.join("\n"), keyboard, options);
    };

    const renderRecentTasks = async (chatId: string, page = 0, options: RenderOptions = {}) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const issues = (await ctx.issues.list({
        companyId,
        limit: 60,
      })) as BotIssue[];
      const sortedIssues = await sortIssuesByRecentCommentActivity(issues, companyId);

      const safePage = clampPage(page, sortedIssues.length, TASKS_PAGE_SIZE);
      upsertSession(chatId, {
        currentScreen: "recent",
        lastTaskList: { kind: "recent", page: safePage },
      });

      if (sortedIssues.length === 0) {
        await renderDashboard(
          chatId,
          t("recent_tasks_empty"),
          [[{ text: t("home"), callback_data: "home" }]],
          options,
        );
        return;
      }

      const start = safePage * TASKS_PAGE_SIZE;
      const pageIssues = sortedIssues.slice(start, start + TASKS_PAGE_SIZE);
      await rememberIssueStatuses(pageIssues);

      const lines = [
        t("recent_tasks_title"),
        "",
        formatPageSummary(language, start + 1, Math.min(start + pageIssues.length, sortedIssues.length), sortedIssues.length),
        t("recent_tasks_sorting"),
        "",
        ...pageIssues.map((issue, index) => {
          const status = `${statusEmoji(issue.status)} ${formatStatus(issue.status, language)}`;
          return `${index + 1 + start}. ${formatIssueListLine(issue, 52, language)}\n${status}`;
        }),
      ];

      const keyboard = pageIssues.map((issue) => [
        {
          text: `${statusEmoji(issue.status)} ${formatIssueButtonLabel(issue, 18, 18, language)}`,
          callback_data: `task:${issue.id}`,
        },
      ]);

      const pagination = buildPageButtons(
        safePage,
        sortedIssues.length,
        TASKS_PAGE_SIZE,
        `recent:${safePage - 1}`,
        `recent:${safePage + 1}`,
      );
      if (pagination) {
        keyboard.push(pagination);
      }

      keyboard.push([
        { text: t("agents"), callback_data: "agents:0" },
        { text: t("home"), callback_data: "home" },
      ]);

      await renderDashboard(chatId, lines.join("\n"), keyboard, options);
    };

    const renderAgentTasks = async (
      chatId: string,
      agentId: string,
      page = 0,
      options: RenderOptions = {},
    ) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const agent = (await ctx.agents.get(agentId, companyId)) as BotAgent | null;
      const agentName = rememberAgentName(agent) ?? t("generic_agent");
      const issues = (await ctx.issues.list({
        companyId,
        assigneeAgentId: agentId,
        limit: 60,
      })) as BotIssue[];

      const safePage = clampPage(page, issues.length, TASKS_PAGE_SIZE);
      upsertSession(chatId, {
        currentScreen: "tasks",
        selectedAgentId: agentId,
        selectedAgentName: agentName,
        lastTaskList: {
          kind: "agent",
          agentId,
          agentName,
          page: safePage,
        },
      });

      if (issues.length === 0) {
        await renderDashboard(
          chatId,
          [t("agent_tasks_empty_title"), "", `<b>${escapeHtml(agentName)}</b>`, "", t("agent_tasks_empty_body")].join("\n"),
          [
            [{ text: t("new_task"), callback_data: `newtask:${agentId}` }],
            [{ text: t("back_to_agents_list"), callback_data: `agents:${sessions.get(chatId)?.agentsPage ?? 0}` }],
            [{ text: t("home"), callback_data: "home" }],
          ],
          options,
        );
        return;
      }

      const start = safePage * TASKS_PAGE_SIZE;
      const pageIssues = issues.slice(start, start + TASKS_PAGE_SIZE);
      await rememberIssueStatuses(pageIssues);

      const lines = [
        formatAgentTasksHeading(language, escapeHtml(agentName)),
        "",
        formatPageSummary(language, start + 1, Math.min(start + pageIssues.length, issues.length), issues.length),
        "",
        ...pageIssues.map((issue, index) => {
          const status = `${statusEmoji(issue.status)} ${formatStatus(issue.status, language)}`;
          const priority = `${priorityEmoji(issue.priority)} ${formatPriority(issue.priority, language)}`;
          return `${index + 1 + start}. ${formatIssueListLine(issue, 46, language)}\n${status} · ${priority}`;
        }),
      ];

      const keyboard = pageIssues.map((issue) => [
        {
          text: `${statusEmoji(issue.status)} ${formatIssueButtonLabel(issue, 18, 18, language)}`,
          callback_data: `task:${issue.id}`,
        },
      ]);

      const pagination = buildPageButtons(
        safePage,
        issues.length,
        TASKS_PAGE_SIZE,
        `agent:${agentId}:${safePage - 1}`,
        `agent:${agentId}:${safePage + 1}`,
      );
      if (pagination) {
        keyboard.push(pagination);
      }

      keyboard.push([{ text: t("new_task"), callback_data: `newtask:${agentId}` }]);
      keyboard.push([
        { text: t("back_to_agents"), callback_data: `agents:${sessions.get(chatId)?.agentsPage ?? 0}` },
        { text: t("home"), callback_data: "home" },
      ]);

      await renderDashboard(chatId, lines.join("\n"), keyboard, options);
    };

    const renderCurrentAgentTasks = async (chatId: string, options: RenderOptions = {}) => {
      const session = upsertSession(chatId);
      if (!session.selectedAgentId) {
        await renderAgents(chatId, 0, {
          ...options,
          notice: options.notice ?? t("select_agent_first_notice"),
        });
        return;
      }

      const page = session.lastTaskList?.kind === "agent" ? session.lastTaskList.page : 0;
      await renderAgentTasks(chatId, session.selectedAgentId, page, options);
    };

    const renderTaskProjectPicker = async (
      chatId: string,
      agentId: string,
      page = 0,
      options: RenderOptions = {},
      draft?: { title: string; description: string },
    ) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const agent = (await ctx.agents.get(agentId, companyId)) as BotAgent | null;
      if (!agent) {
        await renderAgents(chatId, sessions.get(chatId)?.agentsPage ?? 0, {
          ...options,
          notice: t("agent_not_found_notice"),
        });
        return;
      }
      rememberAgentName(agent);

      const previousSession = sessions.get(chatId);
      const persistedDraft =
        previousSession?.pendingTaskAgentId === agent.id && previousSession.pendingTaskDraftTitle
          ? {
              title: previousSession.pendingTaskDraftTitle,
              description: previousSession.pendingTaskDraftDescription ?? "",
            }
          : undefined;
      const nextDraft = draft ?? persistedDraft;
      const projects = await listActiveProjects(companyId);
      const safePage = clampPage(page, projects.length, PROJECTS_PAGE_SIZE);
      const start = safePage * PROJECTS_PAGE_SIZE;
      const pageProjects = projects.slice(start, start + PROJECTS_PAGE_SIZE);
      const tasksPage =
        previousSession?.lastTaskList?.kind === "agent" && previousSession.lastTaskList.agentId === agent.id
          ? previousSession.lastTaskList.page
          : 0;

      upsertSession(chatId, {
        currentScreen: "taskProject",
        selectedAgentId: agent.id,
        selectedAgentName: agent.name,
        pendingTaskAgentId: agent.id,
        pendingTaskAgentName: agent.name,
        pendingTaskProjectId: undefined,
        pendingTaskProjectName: undefined,
        pendingTaskPromptMessageId: undefined,
        pendingTaskDraftTitle: nextDraft?.title,
        pendingTaskDraftDescription: nextDraft?.description,
      });

      const lines = [
        t("new_task_for", { agent: escapeHtml(agent.name) }),
        "",
        t("choose_project"),
        t("can_create_without_project"),
      ];

      if (projects.length > 0) {
        lines.push(
          "",
          formatPageSummary(language, start + 1, Math.min(start + pageProjects.length, projects.length), projects.length),
        );
      } else {
        lines.push("", t("no_active_projects"));
      }

      if (nextDraft) {
        lines.push("", t("task_text_already_captured"));
      }

      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
        [{ text: t("no_project"), callback_data: `newtaskproject:${agent.id}:none` }],
      ];

      for (const project of pageProjects) {
        keyboard.push([
          {
            text: truncate(project.name, 32),
            callback_data: `newtaskproject:${agent.id}:${project.id}`,
          },
        ]);
      }

      const pagination = buildPageButtons(
        safePage,
        projects.length,
        PROJECTS_PAGE_SIZE,
        `newtaskprojects:${agent.id}:${safePage - 1}`,
        `newtaskprojects:${agent.id}:${safePage + 1}`,
      );
      if (pagination) {
        keyboard.push(pagination);
      }

      keyboard.push([
        { text: t("back_to_agent_tasks"), callback_data: `agent:${agent.id}:${tasksPage}` },
        { text: t("home"), callback_data: "home" },
      ]);

      await renderDashboard(chatId, lines.join("\n"), keyboard, options);
    };

    const renderTaskAgentPicker = async (
      chatId: string,
      issueId: string,
      page = 0,
      options: RenderOptions = {},
    ) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const [issue, agents] = await Promise.all([
        ctx.issues.get(issueId, companyId) as Promise<BotIssue | null>,
        ctx.agents.list({ companyId }) as Promise<BotAgent[]>,
      ]);
      for (const agent of agents) {
        rememberAgentName(agent);
      }

      if (!issue) {
        await renderDashboard(
          chatId,
          t("reassign_issue_not_found"),
          [[{ text: t("home"), callback_data: "home" }]],
          options,
        );
        return;
      }

      if (agents.length === 0) {
        await renderDashboard(
          chatId,
          t("reassign_agents_empty"),
          [
            [{ text: t("back_to_task"), callback_data: `task:${issue.id}` }],
            [{ text: t("home"), callback_data: "home" }],
          ],
          options,
        );
        return;
      }

      const safePage = clampPage(page, agents.length, AGENTS_PAGE_SIZE);
      const start = safePage * AGENTS_PAGE_SIZE;
      const pageAgents = agents.slice(start, start + AGENTS_PAGE_SIZE);

      upsertSession(chatId, {
        currentScreen: "taskAgent",
        selectedTaskId: issue.id,
      });

      const currentAssignee = await resolveIssueAssigneeLabel(issue, companyId);
      const lines = [
        t("reassign_title"),
        "",
        `<b>${t("task_label")}:</b> ${escapeHtml(formatIssueDisplayName(issue, 72, language))}`,
        "",
        `<b>${t("current_assignee")}:</b> ${escapeHtml(currentAssignee)}`,
        formatPageSummary(language, start + 1, Math.min(start + pageAgents.length, agents.length), agents.length),
        "",
        t("choose_new_agent"),
      ];

      const keyboard = pageAgents.map((agent) => [
        {
          text: `${issue.assigneeAgentId === agent.id ? "✅ " : ""}${truncate(agent.name, 28)}`,
          callback_data: `taskassign:${agent.id}`,
        },
      ]);

      const pagination = buildPageButtons(
        safePage,
        agents.length,
        AGENTS_PAGE_SIZE,
        `taskagents:${safePage - 1}`,
        `taskagents:${safePage + 1}`,
      );
      if (pagination) {
        keyboard.push(pagination);
      }

      keyboard.push([{ text: t("back_to_task"), callback_data: `task:${issue.id}` }]);
      keyboard.push([{ text: t("home"), callback_data: "home" }]);

      await renderDashboard(chatId, lines.join("\n"), keyboard, options);
    };

    const reassignTaskAgent = async (
      chatId: string,
      issueId: string,
      agentId: string,
      options: RenderOptions = {},
    ) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const [issue, agent] = await Promise.all([
        ctx.issues.get(issueId, companyId) as Promise<BotIssue | null>,
        ctx.agents.get(agentId, companyId) as Promise<BotAgent | null>,
      ]);

      if (!issue) {
        await renderDashboard(
          chatId,
          t("task_not_found_short"),
          [[{ text: t("home"), callback_data: "home" }]],
          options,
        );
        return;
      }

      if (!agent) {
        await renderTaskAgentPicker(chatId, issueId, 0, {
          ...options,
          notice: t("agent_not_found_choose_other"),
        });
        return;
      }
      rememberAgentName(agent);

      if (issue.assigneeAgentId === agent.id) {
        await renderTaskDetail(chatId, issue.id, {
          ...options,
          notice: formatTaskAlreadyAssignedNotice(language, agent.name),
        });
        return;
      }

      const updatedIssue = (await ctx.issues.update(
        issue.id,
        {
          assigneeAgentId: agent.id,
        },
        companyId,
      )) as BotIssue;

      const session = upsertSession(chatId, {
        selectedAgentId: agent.id,
        selectedAgentName: agent.name,
        selectedTaskId: updatedIssue.id,
      });

      if (session.lastTaskList?.kind === "agent") {
        upsertSession(chatId, {
          lastTaskList: {
            kind: "agent",
            agentId: agent.id,
            agentName: agent.name,
            page: 0,
          },
        });
      }

      await rememberIssueStatus(updatedIssue.id, updatedIssue.status);
      await renderTaskDetail(chatId, updatedIssue.id, {
        ...options,
        notice: formatTaskReassignedNotice(language, agent.name),
      });
    };

    const findIssueByReference = async (chatId: string, reference: string): Promise<BotIssue | null> => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return null;
      }

      const normalizedReference = reference.trim().toLowerCase();
      if (!normalizedReference) {
        return null;
      }

      const session = sessions.get(chatId);
      const candidateLists: Array<Promise<BotIssue[]>> = [];

      if (session?.selectedAgentId) {
        candidateLists.push(
          ctx.issues.list({
            companyId,
            assigneeAgentId: session.selectedAgentId,
            limit: 60,
          }) as Promise<BotIssue[]>,
        );
      }

      candidateLists.push(
        ctx.issues.list({
          companyId,
          limit: 100,
        }) as Promise<BotIssue[]>,
      );

      for (const listPromise of candidateLists) {
        const issues = await listPromise;
        const match = issues.find((issue) => {
          return issue.id === reference || issue.identifier?.toLowerCase() === normalizedReference;
        });

        if (match) {
          return match;
        }
      }

      return null;
    };

    const renderTaskDetail = async (chatId: string, issueId: string, options: RenderOptions = {}) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const issue = (await ctx.issues.get(issueId, companyId)) as BotIssue | null;
      if (!issue) {
        await renderDashboard(
          chatId,
          t("task_not_found_context_changed"),
          [[{ text: t("home"), callback_data: "home" }]],
          options,
        );
        return;
      }

      await rememberIssueStatus(issue.id, issue.status);

      let commentsCount = 0;
      try {
        commentsCount = ((await ctx.issues.listComments(issue.id, companyId)) as BotIssueComment[]).length;
      } catch (error) {
        ctx.logger.warn("Failed to load task comments count", { error, issueId: issue.id });
      }

      const session = upsertSession(chatId, {
        currentScreen: "task",
        selectedTaskId: issue.id,
      });

      const assigneeName = await resolveIssueAssigneeLabel(
        issue,
        companyId,
        session.selectedAgentId === issue.assigneeAgentId ? session.selectedAgentName : undefined,
      );
      const assigneeLine = `<b>${t("assignee_label")}:</b> ${escapeHtml(assigneeName)}`;

      let projectLine = `<b>${t("project_label")}:</b> ${t("no_project_value")}`;
      if (issue.project?.name) {
        rememberProjectName(issue.project);
        projectLine = `<b>${t("project_label")}:</b> ${escapeHtml(issue.project.name)}`;
      } else if (issue.projectId) {
        const projectName = await resolveProjectName(companyId, issue.projectId);
        projectLine = `<b>${t("project_label")}:</b> ${escapeHtml(projectName ?? t("project_not_found_value"))}`;
      }

      const lines = [
        ...buildIssueHeadingLines(issue, language),
        "",
        `<b>${t("status_label")}:</b> ${statusEmoji(issue.status)} ${escapeHtml(formatStatus(issue.status, language))}`,
        `<b>${t("priority_label")}:</b> ${priorityEmoji(issue.priority)} ${escapeHtml(formatPriority(issue.priority, language))}`,
        assigneeLine,
        projectLine,
        `<b>${t("comments_count_label")}:</b> ${commentsCount}`,
      ];

      const description = truncate(issue.description, 900);
      if (description) {
        lines.push("", t("description_heading"), escapeHtml(description));
      }

      lines.push("", t("task_comment_hint"));

      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
        [
          {
            text: formatCommentsButton(language, commentsCount),
            callback_data: `comments:${issue.id}:0`,
          },
          { text: t("comment"), callback_data: `comment:${issue.id}` },
        ],
        [
          { text: t("reassign"), callback_data: `taskagent:${issue.id}` },
          { text: t("refresh"), callback_data: `task:${issue.id}` },
        ],
      ];

      if (issue.assigneeAgentId) {
        keyboard.push([{ text: t("back_to_agent_tasks"), callback_data: `agent:${issue.assigneeAgentId}:0` }]);
      }

      if (session.lastTaskList) {
        keyboard.push([{ text: t("back_to_list"), callback_data: "back:list" }]);
      }

      keyboard.push([{ text: t("home"), callback_data: "home" }]);

      await renderDashboard(chatId, lines.join("\n"), keyboard, options);
    };

    const renderTaskComments = async (
      chatId: string,
      issueId: string,
      page = 0,
      options: RenderOptions = {},
    ) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const issue = (await ctx.issues.get(issueId, companyId)) as BotIssue | null;
      if (!issue) {
        await renderDashboard(
          chatId,
          t("comments_issue_not_found"),
          [[{ text: t("home"), callback_data: "home" }]],
          options,
        );
        return;
      }

      await rememberIssueStatus(issue.id, issue.status);

      const comments = sortCommentsByNewest(
        (await ctx.issues.listComments(issue.id, companyId)) as BotIssueComment[],
      );
      const safePage = clampPage(page, comments.length, COMMENTS_PAGE_SIZE);
      const session = upsertSession(chatId, {
        currentScreen: "comments",
        selectedTaskId: issue.id,
      });

      if (comments.length === 0) {
        await renderDashboard(
          chatId,
          [
            ...buildIssueHeadingLines(issue, language),
            "",
            t("comments_heading"),
            "",
            t("comments_empty"),
          ].join("\n"),
          [
            [{ text: t("add_comment"), callback_data: `comment:${issue.id}` }],
            [{ text: t("back_to_task"), callback_data: `task:${issue.id}` }],
            session.lastTaskList ? [{ text: t("back_to_list"), callback_data: "back:list" }] : [],
            [{ text: t("home"), callback_data: "home" }],
          ].filter((row) => row.length > 0),
          options,
        );
        return;
      }

      const start = safePage * COMMENTS_PAGE_SIZE;
      const pageComments = comments.slice(start, start + COMMENTS_PAGE_SIZE);
      const lines = [
        ...buildIssueHeadingLines(issue, language),
        "",
        t("comment_heading"),
        formatCommentPageSummary(language, start + 1, comments.length),
        "",
      ];

      for (const [index, comment] of pageComments.entries()) {
        const commentBody = comment.body.trim();
        const authorLabel = await resolveCommentAuthorLabel(comment, companyId);
        lines.push(
          `<b>${start + index + 1}. ${escapeHtml(authorLabel)}</b> · ${escapeHtml(formatLocalizedCommentTimestamp(comment.createdAt, language))}`,
          escapeHtml(commentBody || t("empty_comment")),
          "",
        );
      }

      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      const pagination = buildPageButtons(
        safePage,
        comments.length,
        COMMENTS_PAGE_SIZE,
        `comments:${issue.id}:${safePage - 1}`,
        `comments:${issue.id}:${safePage + 1}`,
      );
      if (pagination) {
        keyboard.push(pagination);
      }

      keyboard.push([
        { text: t("add_comment"), callback_data: `comment:${issue.id}` },
        { text: t("back_to_task"), callback_data: `task:${issue.id}` },
      ]);

      if (session.lastTaskList) {
        keyboard.push([{ text: t("back_to_list"), callback_data: "back:list" }]);
      }

      keyboard.push([{ text: t("home"), callback_data: "home" }]);

      await renderDashboard(chatId, lines.join("\n").trimEnd(), keyboard, options);
    };

    const startCommentFlow = async (chatId: string, issueId: string) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId || !bot) {
        return;
      }

      const issue = (await ctx.issues.get(issueId, companyId)) as BotIssue | null;
      if (!issue) {
        await renderTaskDetail(chatId, issueId, { notice: t("comment_task_not_found") });
        return;
      }

      clearPendingComment(chatId);
      clearPendingTaskCreation(chatId);
      const session = sessions.get(chatId);

      const prompt = await bot.sendMessage(
        chatId,
        t("comment_reply_prompt", {
          task: escapeHtml(formatIssueDisplayName(issue, 72, language)),
        }),
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            selective: true,
          },
        },
      );

      upsertSession(chatId, {
        selectedTaskId: issue.id,
        pendingCommentTaskId: issue.id,
        pendingCommentPromptMessageId: prompt.message_id,
        pendingCommentReturnScreen: session?.currentScreen === "comments" ? "comments" : "task",
      });
    };

    const startTaskCreationFlow = async (chatId: string, agentId: string, projectId: string | null) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId || !bot) {
        return;
      }

      const agent = (await ctx.agents.get(agentId, companyId)) as BotAgent | null;
      if (!agent) {
        await renderAgents(chatId, sessions.get(chatId)?.agentsPage ?? 0, {
          notice: t("agent_not_found_notice"),
        });
        return;
      }
      rememberAgentName(agent);

      let project: BotProject | null = null;
      if (projectId) {
        project = (await ctx.projects.get(projectId, companyId)) as BotProject | null;
        if (!project) {
          await renderTaskProjectPicker(chatId, agent.id, 0, {
            notice: t("project_not_found_notice"),
          });
          return;
        }
        rememberProjectName(project);
      }

      clearPendingComment(chatId);
      clearPendingTaskCreation(chatId);

      const prompt = await bot.sendMessage(
        chatId,
        t("create_task_reply_prompt", {
          agent: escapeHtml(agent.name),
          project: escapeHtml(project?.name ?? t("no_project_value")),
        }),
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            selective: true,
          },
        },
      );

      upsertSession(chatId, {
        selectedAgentId: agent.id,
        selectedAgentName: agent.name,
        pendingTaskAgentId: agent.id,
        pendingTaskAgentName: agent.name,
        pendingTaskProjectId: project?.id ?? null,
        pendingTaskProjectName: project?.name,
        pendingTaskPromptMessageId: prompt.message_id,
      });

      await renderDashboard(
        chatId,
        t("waiting_new_task", {
          agent: escapeHtml(agent.name),
          project: escapeHtml(project?.name ?? t("no_project_value")),
        }),
        [[{ text: t("cancel_input"), callback_data: "cancel:newtask" }]],
      );
    };

    const cancelTaskCreationFlow = async (chatId: string, options: RenderOptions = {}) => {
      const session = sessions.get(chatId);
      const promptMessageId = session?.pendingTaskPromptMessageId;
      const agentId = session?.pendingTaskAgentId ?? session?.selectedAgentId;
      const tasksPage =
        session?.lastTaskList?.kind === "agent" && session.lastTaskList.agentId === agentId
          ? session.lastTaskList.page
          : 0;

      clearPendingTaskCreation(chatId);

      if (bot && typeof promptMessageId === "number") {
        try {
          await bot.deleteMessage(chatId, promptMessageId);
        } catch (error) {
          ctx.logger.warn("Failed to delete pending task creation prompt", { error, chatId, promptMessageId });
        }
      }

      if (agentId) {
        await renderAgentTasks(chatId, agentId, tasksPage, {
          ...options,
          notice: options.notice ?? t("task_creation_canceled"),
        });
        return;
      }

      await renderHome(chatId, {
        ...options,
        notice: options.notice ?? t("task_creation_canceled"),
      });
    };

    const createTaskForAgent = async (
      chatId: string,
      agentId: string,
      taskDraft: { title: string; description: string },
      projectId: string | null = null,
      options: RenderOptions = {},
    ) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const agent = (await ctx.agents.get(agentId, companyId)) as BotAgent | null;
      if (!agent) {
        clearPendingTaskCreation(chatId);
        await renderAgents(chatId, sessions.get(chatId)?.agentsPage ?? 0, {
          ...options,
          notice: t("agent_not_found_notice"),
        });
        return;
      }
      rememberAgentName(agent);

      let project: BotProject | null = null;
      if (projectId) {
        project = (await ctx.projects.get(projectId, companyId)) as BotProject | null;
        if (!project) {
          clearPendingComment(chatId);
          await renderTaskProjectPicker(
            chatId,
            agent.id,
            0,
            {
              ...options,
              notice: t("project_not_found_notice"),
            },
            taskDraft,
          );
          return;
        }
        rememberProjectName(project);
      }

      const issue = (await ctx.issues.create({
        companyId,
        projectId,
        title: taskDraft.title,
        description: taskDraft.description,
        assigneeAgentId: agent.id,
        priority: "medium",
      })) as BotIssue;

      await rememberIssueStatus(issue.id, issue.status);
      clearPendingTaskCreation(chatId);
      upsertSession(chatId, {
        selectedAgentId: agent.id,
        selectedAgentName: agent.name,
        selectedTaskId: issue.id,
        lastTaskList: {
          kind: "agent",
          agentId: agent.id,
          agentName: agent.name,
          page: 0,
        },
      });

      await renderTaskDetail(chatId, issue.id, {
        ...options,
        notice: formatTaskCreatedNotice(
          language,
          formatIssueReferenceText(issue, language),
          agent.name,
          project?.name,
        ),
      });
    };

    const addCommentToSelectedTask = async (
      chatId: string,
      commentText: string,
      issueId: string,
      options: RenderOptions = {},
    ) => {
      const companyId = await ensureCompanyId(chatId);
      if (!companyId) {
        return;
      }

      const issue = (await ctx.issues.get(issueId, companyId)) as BotIssue | null;
      if (!issue) {
        await renderDashboard(
          chatId,
          t("task_not_found_short"),
          [[{ text: t("home"), callback_data: "home" }]],
          options,
        );
        return;
      }

      const returnScreen = sessions.get(chatId)?.pendingCommentReturnScreen;
      let issueForRender = issue;
      let reopened = false;
      try {
        if (shouldReopenOnCommentReply(issue.status)) {
          issueForRender = await reopenIssueViaBoardApi(issue);
          reopened = true;
        }

        await addIssueCommentViaBoardApi(issue.id, commentText);
        issueForRender = ((await ctx.issues.get(issue.id, companyId)) as BotIssue | null) ?? issueForRender;
        await rememberIssueStatus(issueForRender.id, issueForRender.status);
      } catch (error) {
        ctx.logger.warn("Failed to add Telegram comment through board API", {
          error,
          issueId: issue.id,
        });
        await renderTaskDetail(chatId, issue.id, {
          ...options,
          notice: t("comment_api_failed"),
        });
        return;
      }
      clearPendingComment(chatId);
      const nextOptions = {
        ...options,
        notice: formatCommentAddedNotice(
          language,
          formatIssueReferenceText(issueForRender, language),
          reopened,
        ),
      };

      if (returnScreen === "comments") {
        await renderTaskComments(chatId, issueForRender.id, 0, nextOptions);
        return;
      }

      await renderTaskDetail(chatId, issueForRender.id, nextOptions);
    };

    const handleCommentReply = async (msg: TelegramBot.Message): Promise<boolean> => {
      if (!bot || !msg.text || msg.text.startsWith("/")) {
        return false;
      }

      const chatId = msg.chat.id.toString();
      const session = sessions.get(chatId);
      if (!session?.pendingCommentTaskId) {
        return false;
      }

      const promptMessageId = session.pendingCommentPromptMessageId;
      const isReplyToPrompt =
        typeof promptMessageId === "number" && msg.reply_to_message?.message_id === promptMessageId;

      if (promptMessageId && !isReplyToPrompt) {
        return false;
      }

      const commentText = asNonEmptyString(msg.text);
      if (!commentText) {
        return true;
      }

      try {
        await addCommentToSelectedTask(chatId, commentText, session.pendingCommentTaskId);
      } catch (error) {
        clearPendingComment(chatId);
        ctx.logger.error("Error adding comment from ForceReply flow", { error });
        await bot.sendMessage(chatId, t("comment_failed"));
      }

      return true;
    };

    const handleTaskCreationReply = async (msg: TelegramBot.Message): Promise<boolean> => {
      if (!bot || !msg.text || msg.text.startsWith("/")) {
        return false;
      }

      const chatId = msg.chat.id.toString();
      const session = sessions.get(chatId);
      if (!session?.pendingTaskAgentId) {
        return false;
      }

      const promptMessageId = session.pendingTaskPromptMessageId;
      const isReplyToPrompt =
        typeof promptMessageId === "number" && msg.reply_to_message?.message_id === promptMessageId;

      if (promptMessageId && !isReplyToPrompt) {
        return false;
      }

      const taskDraft = parseTaskDraft(msg.text);
      if (!taskDraft) {
        await bot.sendMessage(
          chatId,
          t("invalid_task_draft"),
        );
        return true;
      }

      try {
        await createTaskForAgent(chatId, session.pendingTaskAgentId, taskDraft, session.pendingTaskProjectId ?? null);
      } catch (error) {
        clearPendingTaskCreation(chatId);
        ctx.logger.error("Error creating task from ForceReply flow", { error });
        await bot.sendMessage(chatId, t("create_task_failed"));
      }

      return true;
    };

    await initializeSelectedCompany();

    const { changed: configSanitized, config: sanitizedConfig } = sanitizeStoredConfig(rawConfig);
    if (configSanitized) {
      try {
        await persistSanitizedPluginConfig(sanitizedConfig);
        ctx.logger.info("Sanitized legacy plugin config", {
          removedKeys: Object.keys(rawConfig).filter((key) => !ALLOWED_CONFIG_KEYS.has(key)),
        });
      } catch (error) {
        ctx.logger.warn("Failed to sanitize legacy plugin config", { error });
      }
    }

    if (config.telegramBotToken) {
      try {
        bot = new TelegramBot(config.telegramBotToken, { polling: true });

        bot.on("polling_error", (error) => {
          ctx.logger.error("Telegram polling error", { error });
        });

        await bot.setMyCommands(botCommands);
        await bot.setChatMenuButton({
          menu_button: { type: "commands" },
        });

        ctx.logger.info("✅ Telegram bot initialized");

        bot.on("message", async (msg) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          if (await handleTaskCreationReply(msg)) {
            return;
          }

          if (await handleCommentReply(msg)) {
            return;
          }
        });

        bot.onText(/^\/start(?:@\w+)?(?:\s+.+)?$/, async (msg) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          await rememberChatId(chatId);
          clearPendingComment(chatId);
          clearPendingTaskCreation(chatId);
          upsertSession(chatId);
          await renderHome(chatId, {
            notice: t("chat_linked_notice"),
          });
        });

        bot.onText(/^\/menu(?:@\w+)?$/, async (msg) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          await rememberChatId(chatId);
          clearPendingComment(chatId);
          clearPendingTaskCreation(chatId);
          await renderHome(chatId);
        });

        bot.onText(/^\/reset(?:@\w+)?$/, async (msg) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          await rememberChatId(chatId);
          await resetDashboard(chatId);
        });

        bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          await renderHelp(chatId);
        });

        bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          await renderStatus(chatId);
        });

        bot.onText(/^\/agents(?:@\w+)?$/, async (msg) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          await renderAgents(chatId);
        });

        bot.onText(/^\/tasks(?:@\w+)?$/, async (msg) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          await renderCurrentAgentTasks(chatId);
        });

        bot.onText(/^\/newtask(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          const session = sessions.get(chatId);
          if (!session?.selectedAgentId) {
            await renderAgents(chatId, 0, {
              notice: t("select_agent_first_notice"),
            });
            return;
          }

          const rawTaskText = match?.[1];
          clearPendingComment(chatId);
          clearPendingTaskCreation(chatId);

          if (!asNonEmptyString(rawTaskText)) {
            await renderTaskProjectPicker(chatId, session.selectedAgentId, 0);
            return;
          }

          const taskDraft = parseTaskDraft(rawTaskText);
          if (!taskDraft) {
            await bot?.sendMessage(
              chatId,
              t("invalid_task_draft"),
            );
            return;
          }

          try {
            await renderTaskProjectPicker(chatId, session.selectedAgentId, 0, {}, taskDraft);
          } catch (error) {
            ctx.logger.error("Error creating task", { error });
            await bot?.sendMessage(chatId, t("create_task_error_short"));
          }
        });

        bot.onText(/^\/task(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          const reference = asNonEmptyString(match?.[1]);
          if (!reference) {
            const selectedTaskId = sessions.get(chatId)?.selectedTaskId;
            if (!selectedTaskId) {
              await renderRecentTasks(chatId, 0, {
                notice: t("select_task_first_notice"),
              });
              return;
            }

            await renderTaskDetail(chatId, selectedTaskId);
            return;
          }

          try {
            const issue = await findIssueByReference(chatId, reference);
            if (!issue) {
              await renderRecentTasks(chatId, 0, {
                notice: formatTaskNotFoundByReference(language, reference),
              });
              return;
            }

            await renderTaskDetail(chatId, issue.id);
          } catch (error) {
            ctx.logger.error("Error getting task details", { error });
            await bot?.sendMessage(chatId, t("load_task_error"));
          }
        });

        bot.onText(/^\/comment(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
          const chatId = msg.chat.id.toString();
          if (!(await ensureAuthorizedChat(chatId, msg.from?.id))) {
            return;
          }

          const session = sessions.get(chatId);
          const commentText = asNonEmptyString(match?.[1]);
          if (!session?.selectedTaskId) {
            await renderRecentTasks(chatId, 0, {
              notice: t("open_task_first_notice"),
            });
            return;
          }

          try {
            if (!commentText) {
              await startCommentFlow(chatId, session.selectedTaskId);
              return;
            }

            await addCommentToSelectedTask(chatId, commentText, session.selectedTaskId);
          } catch (error) {
            ctx.logger.error("Error adding comment", { error });
            await bot?.sendMessage(chatId, t("add_comment_error"));
          }
        });

        bot.on("callback_query", async (query) => {
          const chatId = query.message?.chat.id.toString();
          const data = query.data;
          const messageId = query.message?.message_id;

          if (!chatId || !data || typeof messageId !== "number") {
            return;
          }

          if (!(await ensureAuthorizedCallback(query.id, query.from.id))) {
            return;
          }

          try {
            if (data === "noop") {
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data === "home") {
              await renderHome(chatId, { preferredMessageId: messageId });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data === "reset") {
              await resetDashboard(chatId, messageId);
              await bot?.answerCallbackQuery(query.id, {
                text: t("screen_recreated"),
                show_alert: false,
              });
              return;
            }

            if (data === "companies") {
              await renderCompanies(chatId, { preferredMessageId: messageId });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data === "help") {
              await renderHelp(chatId, { preferredMessageId: messageId });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data === "status") {
              await renderStatus(chatId, { preferredMessageId: messageId });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data === "mytasks") {
              await renderCurrentAgentTasks(chatId, { preferredMessageId: messageId });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data === "cancel:newtask") {
              await cancelTaskCreationFlow(chatId, { preferredMessageId: messageId });
              await bot?.answerCallbackQuery(query.id, {
                text: t("new_task_input_canceled"),
                show_alert: false,
              });
              return;
            }

            if (data === "back:list") {
              const lastTaskList = sessions.get(chatId)?.lastTaskList;
              if (!lastTaskList) {
                await renderHome(chatId, { preferredMessageId: messageId });
              } else if (lastTaskList.kind === "recent") {
                await renderRecentTasks(chatId, lastTaskList.page, {
                  preferredMessageId: messageId,
                });
              } else if (lastTaskList.agentId) {
                await renderAgentTasks(chatId, lastTaskList.agentId, lastTaskList.page, {
                  preferredMessageId: messageId,
                });
              } else {
                await renderHome(chatId, { preferredMessageId: messageId });
              }

              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("agents:")) {
              const page = Number(data.split(":")[1] ?? "0");
              await renderAgents(chatId, Number.isFinite(page) ? page : 0, {
                preferredMessageId: messageId,
              });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("recent:")) {
              const page = Number(data.split(":")[1] ?? "0");
              await renderRecentTasks(chatId, Number.isFinite(page) ? page : 0, {
                preferredMessageId: messageId,
              });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("agent:")) {
              const [, agentId, pageToken] = data.split(":");
              const page = Number(pageToken ?? "0");
              await renderAgentTasks(chatId, agentId, Number.isFinite(page) ? page : 0, {
                preferredMessageId: messageId,
              });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("newtaskprojects:")) {
              const [, agentId, pageToken] = data.split(":");
              const page = Number(pageToken ?? "0");
              await renderTaskProjectPicker(chatId, agentId, Number.isFinite(page) ? page : 0, {
                preferredMessageId: messageId,
              });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("newtaskproject:")) {
              const [, agentId, projectToken] = data.split(":");
              const projectId = projectToken === "none" ? null : projectToken;
              const session = sessions.get(chatId);
              const draft =
                session?.pendingTaskDraftTitle
                  ? {
                      title: session.pendingTaskDraftTitle,
                      description: session.pendingTaskDraftDescription ?? "",
                    }
                  : null;

              if (draft) {
                await createTaskForAgent(chatId, agentId, draft, projectId, {
                  preferredMessageId: messageId,
                });
                await bot?.answerCallbackQuery(query.id);
                return;
              }

              await startTaskCreationFlow(chatId, agentId, projectId);
              await bot?.answerCallbackQuery(query.id, {
                text: projectId
                  ? t("project_selected_reply")
                  : t("no_project_selected_reply"),
                show_alert: false,
              });
              return;
            }

            if (data.startsWith("newtask:")) {
              const agentId = data.split(":")[1];
              clearPendingComment(chatId);
              clearPendingTaskCreation(chatId);
              await renderTaskProjectPicker(chatId, agentId, 0, {
                preferredMessageId: messageId,
              });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("company:")) {
              const companyId = data.split(":")[1];
              const { changed, companyName } = await switchCurrentCompany(companyId);
              clearCompanyScopedSelections(chatId);
              await renderHome(chatId, {
                preferredMessageId: messageId,
                notice: changed
                  ? formatCompanySwitchedNotice(language, companyName)
                  : formatCompanyAlreadySelectedNotice(language, companyName),
              });
              await bot?.answerCallbackQuery(query.id, {
                text: changed ? t("organization_switched_toast") : t("organization_already_selected_toast"),
                show_alert: false,
              });
              return;
            }

            if (data.startsWith("task:")) {
              const taskId = data.split(":")[1];
              await renderTaskDetail(chatId, taskId, { preferredMessageId: messageId });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("taskagent:")) {
              const taskId = data.split(":")[1];
              await renderTaskAgentPicker(chatId, taskId, 0, { preferredMessageId: messageId });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("taskagents:")) {
              const page = Number(data.split(":")[1] ?? "0");
              const taskId = sessions.get(chatId)?.selectedTaskId;
              if (!taskId) {
                await renderHome(chatId, { preferredMessageId: messageId });
                await bot?.answerCallbackQuery(query.id, {
                  text: t("open_task_first_short"),
                  show_alert: false,
                });
                return;
              }

              await renderTaskAgentPicker(chatId, taskId, Number.isFinite(page) ? page : 0, {
                preferredMessageId: messageId,
              });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("taskassign:")) {
              const agentId = data.split(":")[1];
              const taskId = sessions.get(chatId)?.selectedTaskId;
              if (!taskId) {
                await renderHome(chatId, { preferredMessageId: messageId });
                await bot?.answerCallbackQuery(query.id, {
                  text: t("open_task_first_short"),
                  show_alert: false,
                });
                return;
              }

              await reassignTaskAgent(chatId, taskId, agentId, {
                preferredMessageId: messageId,
              });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("comments:")) {
              const [, taskId, pageToken] = data.split(":");
              const page = Number(pageToken ?? "0");
              await renderTaskComments(chatId, taskId, Number.isFinite(page) ? page : 0, {
                preferredMessageId: messageId,
              });
              await bot?.answerCallbackQuery(query.id);
              return;
            }

            if (data.startsWith("comment:")) {
              const taskId = data.split(":")[1];
              await startCommentFlow(chatId, taskId);
              await bot?.answerCallbackQuery(query.id, {
                text: t("reply_to_add_comment"),
                show_alert: false,
              });
              return;
            }

            await bot?.answerCallbackQuery(query.id, {
              text: t("unknown_action"),
              show_alert: true,
            });
          } catch (error) {
            ctx.logger.error("Error handling callback", { error, data });
            await bot?.answerCallbackQuery(query.id, {
              text: t("callback_error"),
              show_alert: true,
            });
          }
        });

        ctx.logger.info("✅ Telegram bot handlers registered");
      } catch (error) {
        ctx.logger.error("Failed to initialize Telegram bot", { error });
      }
    } else {
      ctx.logger.info("Telegram bot token is not configured yet");
    }

    ctx.tools.register(
      "send-telegram-message",
      {
        displayName: "Send Telegram Message",
        description: "Send a message to Telegram",
        parametersSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Message text" },
            chatId: { type: "string", description: "Chat ID (optional)" },
          },
          required: ["message"],
        },
      },
      async (params: { message: string; chatId?: string }) => {
        const { message, chatId } = params;
        const targetChatId = chatId || notificationChatId;
        if (!targetChatId || !bot) {
          return {
            error: "Telegram chat is not configured",
            content: "❌ Telegram chat is not configured",
          };
        }

        try {
          await bot.sendMessage(targetChatId, message);
          return {
            content: "✅ Message sent to Telegram",
            data: { success: true, chatId: targetChatId },
          };
        } catch (error) {
          ctx.logger.error("Error sending Telegram message", { error });
          return {
            error: "Failed to send message",
            content: "❌ Failed to send message",
          };
        }
      },
    );

    ctx.tools.register(
      "create-task-from-telegram",
      {
        displayName: "Create Task from Telegram",
        description: "Create a task in Paperclip",
        parametersSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task title" },
            description: { type: "string", description: "Task description" },
            agentId: { type: "string", description: "Agent ID" },
            projectId: { type: "string", description: "Project ID" },
            priority: {
              type: "string",
              enum: ["critical", "high", "medium", "low"],
              description: "Priority",
            },
          },
          required: ["title", "agentId"],
        },
      },
      async (params: {
        title: string;
        description?: string;
        agentId: string;
        projectId?: string;
        priority?: "critical" | "high" | "medium" | "low";
      }) => {
        const { title, description, agentId, projectId, priority = "medium" } = params;
        const companyId = currentCompanyId ?? (await initializeSelectedCompany());
        if (!companyId) {
          return {
            error: "Company ID not set",
            content: "❌ Company ID not set",
          };
        }

        try {
          const issue = await ctx.issues.create({
            companyId,
            projectId: projectId ?? null,
            title,
            description: description || "",
            assigneeAgentId: agentId,
            priority,
          });

          await rememberIssueStatus((issue as BotIssue).id, (issue as BotIssue).status);
          await sendTelegramNotification(
            formatTaskCreatedNotice(
              language,
              formatIssueReferenceText(issue as BotIssue, language),
              agentId,
            ).replace(/\.$/, "") + `\n${title}`,
          );

          return {
            content: `✅ Created task: ${formatIssueDisplayName(issue as BotIssue, 80)}`,
            data: {
              issueId: (issue as BotIssue).id,
              identifier: (issue as BotIssue).identifier,
            },
          };
        } catch (error) {
          ctx.logger.error("Error creating task", { error });
          return {
            error: "Failed to create task",
            content: "❌ Failed to create task",
          };
        }
      },
    );

    ctx.events.on("issue.created", async (event) => {
      ctx.logger.info("Issue created", { issueId: event.entityId });
      if (currentCompanyId !== event.companyId) {
        return;
      }

      try {
        if (event.entityId) {
          const issue = (await ctx.issues.get(event.entityId, event.companyId)) as BotIssue | null;
          if (issue) {
            await rememberIssueStatus(issue.id, issue.status);
            await sendTelegramNotification(
              formatTaskCreatedNotification(
                language,
                formatIssueDisplayName(issue, 80, language),
                formatStatus(issue.status, language),
              ),
            );
          }
        }
      } catch (error) {
        ctx.logger.error("Error sending Telegram notification", { error });
      }
    });

    ctx.events.on("issue.updated", async (event) => {
      ctx.logger.info("Issue updated", { issueId: event.entityId });
      if (currentCompanyId !== event.companyId || !event.entityId) {
        return;
      }

      try {
        const issue = (await ctx.issues.get(event.entityId, event.companyId)) as BotIssue | null;
        if (!issue) {
          await ctx.state.delete(issueStatusStateScope(event.entityId));
          return;
        }

        const previousStatus = await readIssueStatus(issue.id);
        await rememberIssueStatus(issue.id, issue.status);
        await notifyIfIssueBlocked(issue, previousStatus);
      } catch (error) {
        ctx.logger.error("Error processing issue.updated event", { error, issueId: event.entityId });
      }
    });

    ctx.events.on("issue.comment.created", async (event) => {
      ctx.logger.info("Issue comment created", { issueId: event.entityId });
      if (currentCompanyId !== event.companyId) {
        return;
      }

      try {
        if (event.entityId) {
          const issue = (await ctx.issues.get(event.entityId, event.companyId)) as BotIssue | null;
          if (issue) {
            await sendTelegramNotification(
              formatNewCommentNotification(language, formatIssueDisplayName(issue, 80, language)),
            );
          }
        }
      } catch (error) {
        ctx.logger.error("Error sending Telegram notification", { error });
      }
    });

    ctx.logger.info("✅ Telegram Task Manager setup complete");
  },

  async onHealth() {
    return {
      status: "ok",
      message: bot ? "Telegram Task Manager is running" : "Telegram Task Manager is waiting for configuration",
      diagnostics: {
        botInitialized: bot !== null,
        sessionsCount: sessions.size,
        companyId: currentCompanyId,
        notificationChatId,
      },
    };
  },

  async onConfigChanged(rawConfig) {
    const previousToken = activeConfig.telegramBotToken;
    const previousLanguage = language;
    const nextConfig = normalizeConfig(rawConfig);

    activeConfig = nextConfig;
    language = nextConfig.language ?? "ru";

    if (nextConfig.telegramChatId) {
      notificationChatId = nextConfig.telegramChatId;
    }

    if (bot && previousLanguage !== language) {
      await bot.setMyCommands(getBotCommands(language));
    }

    if (previousToken && nextConfig.telegramBotToken && previousToken !== nextConfig.telegramBotToken) {
      console.warn("Telegram bot token changed; restart the plugin to apply the new token");
    }
  },

  async onValidateConfig(rawConfig) {
    const config = normalizeConfig(rawConfig);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.telegramBotToken) {
      errors.push("telegramBotToken is required");
    }

    if (config.telegramBotToken) {
      try {
        const validationBot = new TelegramBot(config.telegramBotToken, { polling: false });
        const me = await validationBot.getMe();
        warnings.push(`Telegram bot validated: @${me.username ?? "unknown"}`);
      } catch {
        errors.push("telegramBotToken is invalid or Telegram API is unavailable");
      }
    }

    if (!config.telegramChatId) {
      warnings.push("telegramChatId is empty; the plugin will use the first authorized /start chat");
    }

    return {
      ok: errors.length === 0,
      warnings,
      errors,
    };
  },

  async onShutdown() {
    console.info("👋 Telegram Task Manager shutting down");
    sessions.clear();
    await stopBot();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
