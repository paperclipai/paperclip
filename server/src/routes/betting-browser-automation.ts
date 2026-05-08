import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  bettingBrowserAutomationService,
  DEFAULT_BBA_CHROMIUM_PROFILE,
  type BettingAutomationExecutionOptions,
} from "../services/betting-browser-automation.js";
import { secretService } from "../services/secrets.js";
import { assertCompanyAccess } from "./authz.js";
import { unprocessable } from "../errors.js";

function requireObject(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unprocessable(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unprocessable(`${label} is required.`);
  }
  return value.trim();
}

function requireNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw unprocessable(`${label} must be a valid number.`);
  }
  return value;
}

function optionalString(value: unknown, label: string) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw unprocessable(`${label} must be a string.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string) {
  if (value == null) return undefined;
  if (typeof value !== "boolean") {
    throw unprocessable(`${label} must be a boolean.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw unprocessable(`${label} must be a boolean.`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string) {
  if (value == null) return undefined;
  return requireNumber(value, label);
}

function optionalBrowserName(value: unknown): "chromium" | "firefox" | undefined {
  if (value == null) return undefined;
  if (value !== "chromium" && value !== "firefox") {
    throw unprocessable("execution.browserName must be 'chromium' or 'firefox'.");
  }
  return value;
}

function parseExecution(execution: unknown) {
  if (execution == null) return null;
  const value = requireObject(execution, "execution");
  const finalConfirmationValue = value.finalConfirmation;
  const finalConfirmationObject =
    finalConfirmationValue == null
      ? null
      : requireObject(finalConfirmationValue, "execution.finalConfirmation");
  const finalConfirmation =
    finalConfirmationObject == null
      ? null
      : {
        confirmed: requireBoolean(
          finalConfirmationObject.confirmed,
          "execution.finalConfirmation.confirmed",
        ),
        confirmedBy: optionalString(
          finalConfirmationObject.confirmedBy,
          "execution.finalConfirmation.confirmedBy",
        ),
        approvedOdds: optionalNumber(
          finalConfirmationObject.approvedOdds,
          "execution.finalConfirmation.approvedOdds",
        ),
        oddsDriftTolerancePct: optionalNumber(
          finalConfirmationObject.oddsDriftTolerancePct,
          "execution.finalConfirmation.oddsDriftTolerancePct",
        ),
      };

  return {
    finalConfirmation,
    browserName: optionalBrowserName(value.browserName),
    userDataDir: optionalString(value.userDataDir, "execution.userDataDir"),
    headless: optionalBoolean(value.headless, "execution.headless"),
    skipLogin: optionalBoolean(value.skipLogin, "execution.skipLogin"),
    startUrl: optionalString(value.startUrl, "execution.startUrl"),
    sessionTimeoutMs: optionalNumber(value.sessionTimeoutMs, "execution.sessionTimeoutMs"),
    pageTimeoutMs: optionalNumber(value.pageTimeoutMs, "execution.pageTimeoutMs"),
    actionDelayMinMs: optionalNumber(value.actionDelayMinMs, "execution.actionDelayMinMs"),
    actionDelayMaxMs: optionalNumber(value.actionDelayMaxMs, "execution.actionDelayMaxMs"),
    retryDelayMinMs: optionalNumber(value.retryDelayMinMs, "execution.retryDelayMinMs"),
    retryDelayMaxMs: optionalNumber(value.retryDelayMaxMs, "execution.retryDelayMaxMs"),
    minClickIntervalMs: optionalNumber(value.minClickIntervalMs, "execution.minClickIntervalMs"),
    sessionLabel: optionalString(value.sessionLabel, "execution.sessionLabel"),
  };
}

export function normalizeExecutionForPreAuth(
  execution: BettingAutomationExecutionOptions | null,
): BettingAutomationExecutionOptions | null {
  if (execution?.skipLogin !== true) {
    return execution;
  }

  return {
    ...execution,
    browserName: "chromium",
    userDataDir: DEFAULT_BBA_CHROMIUM_PROFILE,
  };
}

export function bettingBrowserAutomationRoutes(db: Db) {
  const router = Router();
  const secrets = secretService(db);
  const svc = bettingBrowserAutomationService(db, {
    resolveSecret: async (companyId, ref) => {
      if (ref.secretId) {
        return secrets.resolveSecretValue(companyId, ref.secretId, "latest");
      }
      if (ref.secretName) {
        const secret = await secrets.getByName(companyId, ref.secretName);
        if (!secret) throw unprocessable(`Secret not found: ${ref.secretName}`);
        return secrets.resolveSecretValue(companyId, secret.id, "latest");
      }
      throw unprocessable("Secret reference must include secretId or secretName.");
    },
    sendAlert: async (text) => {
      const bot = (globalThis as Record<string, unknown>).__telegramBot as
        | { send: (message: string) => Promise<void> }
        | undefined;
      if (!bot) return;
      await bot.send(text);
    },
  });

  router.post("/companies/:companyId/betting-browser-automation/execute", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const body = requireObject(req.body, "body");
    const bookmakerConfig = requireObject(body.bookmakerConfig, "bookmakerConfig");
    const rawBet = body.bet != null ? requireObject(body.bet, "bet") : null;
    const rawBets = Array.isArray(body.bets) && body.bets.length > 0 ? body.bets : null;
    if (!rawBet && !rawBets) throw unprocessable("Either bet or bets is required.");
    const bet = rawBet ?? rawBets![0]!;
    const riskControls = requireObject(body.riskControls, "riskControls");
    const loginUsername = requireObject(body.loginUsername, "loginUsername");
    const loginPassword = requireObject(body.loginPassword, "loginPassword");

    function parseBetObject(b: Record<string, unknown>, label: string) {
      return {
        predictionId: typeof b.predictionId === "string" ? b.predictionId : null,
        matchLabel: requireString(b.matchLabel, `${label}.matchLabel`),
        market: requireString(b.market, `${label}.market`),
        selection: requireString(b.selection, `${label}.selection`),
        selectionHint: typeof b.selectionHint === "string" ? b.selectionHint : null,
        marketHint: typeof b.marketHint === "string" ? b.marketHint : null,
        odds: requireNumber(b.odds, `${label}.odds`),
        stake: requireNumber(b.stake, `${label}.stake`),
        currency: typeof b.currency === "string" ? b.currency : null,
        eventUrl: typeof b.eventUrl === "string" ? b.eventUrl : null,
        searchQuery: typeof b.searchQuery === "string" ? b.searchQuery : null,
      };
    }

    const execution = normalizeExecutionForPreAuth(parseExecution(body.execution));

    const result = await svc.execute({
      companyId,
      issueId: typeof body.issueId === "string" ? body.issueId : null,
      currentBalance: typeof body.currentBalance === "number" ? body.currentBalance : null,
      sessionStartedAt: typeof body.sessionStartedAt === "string" ? body.sessionStartedAt : null,
      loginUsername: {
        secretId: typeof loginUsername.secretId === "string" ? loginUsername.secretId : null,
        secretName: typeof loginUsername.secretName === "string" ? loginUsername.secretName : null,
      },
      loginPassword: {
        secretId: typeof loginPassword.secretId === "string" ? loginPassword.secretId : null,
        secretName: typeof loginPassword.secretName === "string" ? loginPassword.secretName : null,
      },
      bookmakerConfig: {
        bookmaker: requireString(bookmakerConfig.bookmaker, "bookmakerConfig.bookmaker"),
        baseUrl: requireString(bookmakerConfig.baseUrl, "bookmakerConfig.baseUrl"),
        loginUrl: requireString(bookmakerConfig.loginUrl, "bookmakerConfig.loginUrl"),
        postLoginUrl: typeof bookmakerConfig.postLoginUrl === "string" ? bookmakerConfig.postLoginUrl : null,
        historyUrl: typeof bookmakerConfig.historyUrl === "string" ? bookmakerConfig.historyUrl : null,
        username: requireObject(bookmakerConfig.username, "bookmakerConfig.username") as any,
        password: requireObject(bookmakerConfig.password, "bookmakerConfig.password") as any,
        loginSubmit: requireObject(bookmakerConfig.loginSubmit, "bookmakerConfig.loginSubmit") as any,
        loginSuccess: bookmakerConfig.loginSuccess ? requireObject(bookmakerConfig.loginSuccess, "bookmakerConfig.loginSuccess") as any : undefined,
        loginFailure: bookmakerConfig.loginFailure ? requireObject(bookmakerConfig.loginFailure, "bookmakerConfig.loginFailure") as any : undefined,
        cookieAccept: bookmakerConfig.cookieAccept ? requireObject(bookmakerConfig.cookieAccept, "bookmakerConfig.cookieAccept") as any : undefined,
        popupClose: bookmakerConfig.popupClose ? requireObject(bookmakerConfig.popupClose, "bookmakerConfig.popupClose") as any : undefined,
        searchInput: bookmakerConfig.searchInput ? requireObject(bookmakerConfig.searchInput, "bookmakerConfig.searchInput") as any : undefined,
        searchSubmit: bookmakerConfig.searchSubmit ? requireObject(bookmakerConfig.searchSubmit, "bookmakerConfig.searchSubmit") as any : undefined,
        searchResult: bookmakerConfig.searchResult ? requireObject(bookmakerConfig.searchResult, "bookmakerConfig.searchResult") as any : undefined,
        marketGroup: bookmakerConfig.marketGroup ? requireObject(bookmakerConfig.marketGroup, "bookmakerConfig.marketGroup") as any : undefined,
        selectionButton: requireObject(bookmakerConfig.selectionButton, "bookmakerConfig.selectionButton") as any,
        stakeInput: requireObject(bookmakerConfig.stakeInput, "bookmakerConfig.stakeInput") as any,
        reviewButton: requireObject(bookmakerConfig.reviewButton, "bookmakerConfig.reviewButton") as any,
        submitButton: bookmakerConfig.submitButton ? requireObject(bookmakerConfig.submitButton, "bookmakerConfig.submitButton") as any : undefined,
        receiptSuccess: bookmakerConfig.receiptSuccess ? requireObject(bookmakerConfig.receiptSuccess, "bookmakerConfig.receiptSuccess") as any : undefined,
        reviewSummary: bookmakerConfig.reviewSummary ? requireObject(bookmakerConfig.reviewSummary, "bookmakerConfig.reviewSummary") as any : undefined,
        historyReady: bookmakerConfig.historyReady ? requireObject(bookmakerConfig.historyReady, "bookmakerConfig.historyReady") as any : undefined,
        historySelection: bookmakerConfig.historySelection ? requireObject(bookmakerConfig.historySelection, "bookmakerConfig.historySelection") as any : undefined,
      },
      bet: parseBetObject(bet as Record<string, unknown>, "bet"),
      ...(rawBets ? {
        bets: rawBets.map((b: unknown, i: number) => parseBetObject(requireObject(b, `bets[${i}]`), `bets[${i}]`)),
      } : {}),
      riskControls: {
        maxStakePerBet: requireNumber(riskControls.maxStakePerBet, "riskControls.maxStakePerBet"),
        maxTotalStakePerSession: requireNumber(riskControls.maxTotalStakePerSession, "riskControls.maxTotalStakePerSession"),
        requireFinalConfirmation:
          typeof riskControls.requireFinalConfirmation === "boolean"
            ? riskControls.requireFinalConfirmation
            : true,
        dailyStopLossPct:
          typeof riskControls.dailyStopLossPct === "number" ? riskControls.dailyStopLossPct : undefined,
        sessionStopLossPct:
          typeof riskControls.sessionStopLossPct === "number" ? riskControls.sessionStopLossPct : undefined,
      },
      execution,
    });

    res.json(result);
  });

  return router;
}
