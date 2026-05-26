import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";

import { createMobileChatStore, type MobileChatStore } from "../mobile/chat-store.js";
import { buildMobileSummary } from "../mobile/status.js";
import type { MobileAgentRow, MobileIssueRow } from "../mobile/types.js";

const ASSISTANT_PLACEHOLDER = "헤르 전달 경로가 준비되면 이 요청을 처리합니다.";
const SESSION_COOKIE = "mobile_session";

export interface MobileRoutesDeps {
  mobileToken: string | null | undefined;
  telegramUrl?: string | null;
  loadIssues(): Promise<MobileIssueRow[]>;
  loadAgents(): Promise<MobileAgentRow[]>;
  createChatStore?: () => MobileChatStore;
}

const singletonChatStore = createMobileChatStore();

const parseCookies = (header: string | undefined): Record<string, string> => {
  if (!header) return {};

  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }

  return cookies;
};

const getSessionId = (cookieHeader: string | undefined): string | null => {
  const sessionId = parseCookies(cookieHeader)[SESSION_COOKIE];
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
};

export function mobileRoutes(deps: MobileRoutesDeps) {
  const router = Router();
  const chatStore = deps.createChatStore?.() ?? singletonChatStore;
  const activeSessions = new Set<string>();

  const hasMobileSession = (cookieHeader: string | undefined): boolean => {
    const sessionId = parseCookies(cookieHeader)[SESSION_COOKIE];
    return typeof sessionId === "string" && activeSessions.has(sessionId);
  };

  const requireMobileSession: RequestHandler = (req, res, next) => {
    if (hasMobileSession(req.header("cookie"))) {
      next();
      return;
    }

    res.status(401).json({ error: "Mobile session required" });
  };

  router.post("/auth/login", (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!deps.mobileToken || token !== deps.mobileToken) {
      res.status(401).json({ error: "Invalid mobile token" });
      return;
    }

    const sessionId = randomUUID();
    activeSessions.add(sessionId);
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/api/mobile",
    });
    res.json({ ok: true });
  });

  router.post("/auth/logout", (req, res) => {
    const sessionId = getSessionId(req.header("cookie"));
    if (sessionId) {
      activeSessions.delete(sessionId);
    }

    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      path: "/api/mobile",
    });
    res.json({ ok: true });
  });

  router.use(requireMobileSession);

  router.get("/summary", async (_req, res, next) => {
    try {
      const issues = await deps.loadIssues();
      res.json({
        ...buildMobileSummary(issues),
        telegramUrl: deps.telegramUrl ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/issues", async (_req, res, next) => {
    try {
      res.json({ issues: await deps.loadIssues() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/agents", async (_req, res, next) => {
    try {
      res.json({ agents: await deps.loadAgents() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/reports", (_req, res) => {
    res.json({ reports: [] });
  });

  router.get("/chat/messages", (_req, res) => {
    res.json({ messages: chatStore.list() });
  });

  router.post("/chat/messages", (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "Chat text is required" });
      return;
    }

    const message = chatStore.createUserMessage(text);
    chatStore.createAssistantMessage(ASSISTANT_PLACEHOLDER, message.id);
    res.status(201).json({ message, messages: chatStore.list() });
  });

  router.post("/chat/messages/:id/retry", (req, res, next) => {
    try {
      const message = chatStore.retry(req.params.id);
      res.json({ message });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Mobile chat message not found:")) {
        res.status(404).json({ error: "Mobile chat message not found" });
        return;
      }

      next(error);
    }
  });

  return router;
}
