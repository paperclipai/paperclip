import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { appConfigSummary, getPaperclipConfig } from "./src/config";
import {
  addDiagnosticsBreadcrumb,
  getDiagnosticsSnapshotText,
  recordDiagnosticsError,
  resetDiagnosticsSession,
  setDiagnosticsContext,
} from "./src/diagnostics";
import {
  appendReplayResult as storeReplayResult,
  loadCachedIssueComments,
  loadCachedIssueDetail,
  loadCachedIssueList,
  loadPendingMutations,
  loadReplayResults,
  makeMutationId,
  makeReplayResultId,
  saveCachedIssueComments,
  saveCachedIssueDetail,
  saveCachedIssueList,
  savePendingMutations,
  type PendingMutationDraft,
  type PendingMutation,
  type ReplayResult,
} from "./src/offlineStore";
import {
  addIssueComment,
  checkoutIssue,
  fetchInboxIssues,
  fetchIssueComments,
  fetchIssueDetail,
  type IssuePriority,
  isConflictError,
  isRetriableOfflineError,
  pingPaperclipHealth,
  type IssueComment,
  type IssueDetail,
  type IssueStatus,
  type IssueSummary,
  PaperclipApiError,
  updateIssueStatus,
} from "./src/paperclipApi";
import {
  clearSessionToken,
  loadSessionToken,
  markSessionValidated,
  saveSessionToken,
} from "./src/sessionStore";
import {
  extractIssueIdFromDeepLink,
  loadNotificationPreference,
  parseIssueWakePayload,
  registerForPushNotifications,
  saveNotificationPreference,
  type NotificationPreference,
} from "./src/notifications";
import { TEST_IDS } from "./src/testIds";

const DEFAULT_API_KEY = process.env.EXPO_PUBLIC_PAPERCLIP_API_KEY ?? "";
const QA_SEEDED_API_KEY = process.env.EXPO_PUBLIC_QA_SEEDED_API_KEY ?? "";

const CONNECTIVITY_CHECK_INTERVAL_MS = 15000;

type DataSource = "none" | "network" | "cache";
type InboxStatusFilter = "all" | "todo" | "in_progress" | "blocked";

type ReplayTrigger = "manual" | "reconnect";
type SessionState = "signed_out" | "active" | "expired" | "error";
type NotificationPreferenceState = NotificationPreference | "loading";

const ISSUE_PRIORITY_ORDER: Record<IssuePriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const INBOX_STATUS_FILTERS: Array<{
  key: InboxStatusFilter;
  label: string;
  testId: string;
}> = [
  { key: "all", label: "All", testId: TEST_IDS.inboxFilterAll },
  { key: "todo", label: "To do", testId: TEST_IDS.inboxFilterTodo },
  {
    key: "in_progress",
    label: "In progress",
    testId: TEST_IDS.inboxFilterInProgress,
  },
  { key: "blocked", label: "Blocked", testId: TEST_IDS.inboxFilterBlocked },
];

function formatStatusChipLabel(status: InboxStatusFilter): string {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "todo":
      return "To do";
    case "blocked":
      return "Blocked";
    case "all":
    default:
      return "All";
  }
}

function formatTimestamp(iso: string): string {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
}

function formatOptionalTimestamp(iso: string | null): string {
  return iso ? formatTimestamp(iso) : "Not available";
}

function formatOptionalId(value: string | null): string {
  if (!value) {
    return "Not available";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function buildSessionRunId(prefilledRunId: string): string {
  const trimmed = prefilledRunId.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof PaperclipApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function describeMutation(mutation: PendingMutation): string {
  switch (mutation.kind) {
    case "checkout":
      return "checkout";
    case "comment":
      return "comment";
    case "status":
      return `status:${mutation.status}`;
    default:
      return "unknown";
  }
}

function materializeMutation(
  mutation: PendingMutationDraft,
  options: { id?: string; createdAt?: string; attempts?: number } = {},
): PendingMutation {
  const id = options.id ?? makeMutationId();
  const createdAt = options.createdAt ?? new Date().toISOString();
  const attempts = options.attempts ?? 0;

  switch (mutation.kind) {
    case "checkout":
      return {
        ...mutation,
        id,
        createdAt,
        attempts,
      };
    case "comment":
      return {
        ...mutation,
        id,
        createdAt,
        attempts,
      };
    case "status":
      return {
        ...mutation,
        id,
        createdAt,
        attempts,
      };
    default:
      throw new PaperclipApiError(`Unsupported mutation kind: ${JSON.stringify(mutation)}`);
  }
}

function incrementMutationAttempts(mutation: PendingMutation): PendingMutation {
  switch (mutation.kind) {
    case "checkout":
      return {
        ...mutation,
        attempts: mutation.attempts + 1,
      };
    case "comment":
      return {
        ...mutation,
        attempts: mutation.attempts + 1,
      };
    case "status":
      return {
        ...mutation,
        attempts: mutation.attempts + 1,
      };
    default:
      return mutation;
  }
}

export default function App() {
  const config = useMemo(() => getPaperclipConfig(), []);
  const [sessionRunId] = useState(() => buildSessionRunId(config.runId));

  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState(DEFAULT_API_KEY.trim().length > 0);
  const [sessionState, setSessionState] = useState<SessionState>(
    DEFAULT_API_KEY.trim().length > 0 ? "active" : "signed_out",
  );
  const [sessionStateNote, setSessionStateNote] = useState<string | null>(null);
  const [notificationPreference, setNotificationPreference] =
    useState<NotificationPreferenceState>("loading");
  const [notificationStateNote, setNotificationStateNote] = useState<string | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [expoPushTokenPreview, setExpoPushTokenPreview] = useState<string | null>(null);

  const [isOnline, setIsOnline] = useState(true);
  const [lastConnectivityCheckAt, setLastConnectivityCheckAt] = useState<string | null>(null);

  const [cacheSource, setCacheSource] = useState<DataSource>("none");
  const [inboxStatusFilter, setInboxStatusFilter] =
    useState<InboxStatusFilter>("all");

  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedIssueDetail, setSelectedIssueDetail] = useState<IssueDetail | null>(null);
  const [selectedIssueComments, setSelectedIssueComments] = useState<IssueComment[]>([]);
  const [selectedIssueLoadedAt, setSelectedIssueLoadedAt] = useState<string | null>(null);
  const [selectedIssueSource, setSelectedIssueSource] = useState<DataSource>("none");
  const [detailLoading, setDetailLoading] = useState(false);

  const [commentDraft, setCommentDraft] = useState("");

  const [mutationQueue, setMutationQueue] = useState<PendingMutation[]>([]);
  const [replayResults, setReplayResults] = useState<ReplayResult[]>([]);
  const [replayingQueue, setReplayingQueue] = useState(false);

  const [diagnosticsPreview, setDiagnosticsPreview] = useState<string | null>(null);
  const [diagnosticsGeneratedAt, setDiagnosticsGeneratedAt] = useState<string | null>(null);
  const [showDiagnosticsPreview, setShowDiagnosticsPreview] = useState(false);
  const [sharingDiagnostics, setSharingDiagnostics] = useState(false);

  const queueRef = useRef<PendingMutation[]>([]);
  const wasOnlineRef = useRef<boolean | null>(null);

  const hasRequiredConfig = config.missing.length === 0;
  const hasQaFixture = QA_SEEDED_API_KEY.trim().length > 0;
  const canSubmitAuth = apiKey.trim().length > 0 && hasRequiredConfig && !loading;
  const canRefresh = hasSession && hasRequiredConfig && !loading;
  const canToggleNotifications = hasRequiredConfig && notificationPreference !== "loading";
  const configText = appConfigSummary(config);
  const filteredIssues = useMemo(() => {
    const scoped =
      inboxStatusFilter === "all"
        ? issues
        : issues.filter((issue) => issue.status === inboxStatusFilter);

    return [...scoped].sort(
      (a, b) =>
        ISSUE_PRIORITY_ORDER[a.priority] - ISSUE_PRIORITY_ORDER[b.priority] ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [inboxStatusFilter, issues]);

  useEffect(() => {
    queueRef.current = mutationQueue;
  }, [mutationQueue]);

  const persistQueue = useCallback(async (nextQueue: PendingMutation[]) => {
    queueRef.current = nextQueue;
    setMutationQueue(nextQueue);
    await savePendingMutations(nextQueue);
  }, []);

  const appendReplay = useCallback(
    async (mutation: PendingMutation, outcome: ReplayResult["outcome"], message: string) => {
      const nextResults = await storeReplayResult({
        id: makeReplayResultId(),
        mutationId: mutation.id,
        issueId: mutation.issueId,
        kind: mutation.kind,
        outcome,
        message,
        createdAt: new Date().toISOString(),
      });
      setReplayResults(nextResults);
    },
    [],
  );

  const checkConnectivity = useCallback(async () => {
    const online = await pingPaperclipHealth(config);
    setIsOnline(online);
    setLastConnectivityCheckAt(new Date().toISOString());
    addDiagnosticsBreadcrumb("connectivity_checked", {
      metadata: { online },
    });
    return online;
  }, [config]);

  useEffect(() => {
    resetDiagnosticsSession({
      companyId: config.companyId,
      agentId: config.agentId,
      runId: sessionRunId,
    });
    addDiagnosticsBreadcrumb("app_started", {
      metadata: {
        hasPrefilledApiKey: DEFAULT_API_KEY.trim().length > 0,
        hasQaFixture: QA_SEEDED_API_KEY.trim().length > 0,
      },
    });
  }, [config.agentId, config.companyId, sessionRunId]);

  useEffect(() => {
    const errorUtils = (
      globalThis as {
        ErrorUtils?: {
          getGlobalHandler?: () => ((error: Error, isFatal?: boolean) => void) | undefined;
          setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
        };
      }
    ).ErrorUtils;
    if (!errorUtils?.setGlobalHandler) {
      return;
    }

    const previousHandler = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((runtimeError, isFatal) => {
      recordDiagnosticsError(runtimeError, {
        metadata: {
          operation: "global_error_handler",
          isFatal: Boolean(isFatal),
        },
      });
      previousHandler?.(runtimeError, isFatal);
    });
  }, []);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  }, []);

  useEffect(() => {
    const hydrateSessionContract = async () => {
      try {
        if (config.deploymentMode === "authenticated") {
          await clearSessionToken();
          if (DEFAULT_API_KEY.trim().length === 0) {
            setHasSession(false);
            setSessionState("signed_out");
          }
          setSessionStateNote(
            "Authenticated mode: token is kept in memory only and requires sign-in after app restart.",
          );
          return;
        }

        if (DEFAULT_API_KEY.trim().length > 0) {
          await saveSessionToken(config.deploymentMode, DEFAULT_API_KEY.trim());
          setSessionState("active");
          setSessionStateNote("Using prefilled local_trusted token from environment.");
          return;
        }

        const restored = await loadSessionToken(config.deploymentMode);
        if (restored) {
          setApiKey(restored.token);
          setHasSession(true);
          setSessionState("active");
          setSessionStateNote(
            `Restored local_trusted session from ${formatTimestamp(restored.savedAt)}.`,
          );
        } else {
          setSessionState("signed_out");
          setSessionStateNote("No persisted local_trusted session found.");
        }
      } catch (err) {
        setSessionState("error");
        setSessionStateNote(`Session bootstrap error: ${getErrorMessage(err)}`);
      }
    };

    void hydrateSessionContract();
  }, [config.deploymentMode]);

  useEffect(() => {
    const hydrateState = async () => {
      const [cachedList, queued, history] = await Promise.all([
        loadCachedIssueList(),
        loadPendingMutations(),
        loadReplayResults(),
      ]);

      if (cachedList) {
        setIssues(cachedList.issues);
        setLoadedAt(cachedList.cachedAt);
        setCacheSource("cache");
      }

      queueRef.current = queued;
      setMutationQueue(queued);
      setReplayResults(history);
    };

    void hydrateState();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const hydrateNotificationPreference = async () => {
      if (!hasRequiredConfig) {
        setNotificationPreference("disabled");
        setNotificationStateNote("Set company/agent config before enabling push notifications.");
        return;
      }

      try {
        const persisted = await loadNotificationPreference(config.companyId, config.agentId);
        if (cancelled) {
          return;
        }
        setNotificationPreference(persisted);
        setNotificationStateNote(
          persisted === "enabled"
            ? "Push notifications enabled for assignment + mention wake-ups."
            : "Push notifications currently disabled.",
        );
      } catch (err) {
        if (cancelled) {
          return;
        }
        setNotificationPreference("disabled");
        setNotificationStateNote(`Failed to load notification preference: ${getErrorMessage(err)}`);
      }
    };

    void hydrateNotificationPreference();
    return () => {
      cancelled = true;
    };
  }, [config.agentId, config.companyId, hasRequiredConfig]);

  useEffect(() => {
    void checkConnectivity();
    const timer = setInterval(() => {
      void checkConnectivity();
    }, CONNECTIVITY_CHECK_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [checkConnectivity]);

  const invalidateSession = useCallback(
    async (reason: string) => {
      setHasSession(false);
      setSessionState("expired");
      setSessionStateNote(reason);
      setApiKey("");
      await clearSessionToken();
      addDiagnosticsBreadcrumb("session_invalidated", {
        level: "error",
        metadata: {
          reason,
          mode: config.deploymentMode,
        },
      });
    },
    [config.deploymentMode],
  );

  const loadIssues = useCallback(
    async (tokenOverride?: string) => {
      const token = (tokenOverride ?? apiKey).trim();
      addDiagnosticsBreadcrumb("inbox_fetch_requested", {
        metadata: {
          hasToken: token.length > 0,
          hasRequiredConfig,
        },
      });

      if (!hasRequiredConfig) {
        setError("Set required app config values before continuing.");
        addDiagnosticsBreadcrumb("inbox_fetch_rejected", {
          level: "error",
          metadata: { reason: "missing_config" },
        });
        return;
      }
      if (token.length === 0) {
        setError("Enter a bearer token to continue.");
        setSessionState("signed_out");
        setSessionStateNote("No token loaded.");
        addDiagnosticsBreadcrumb("inbox_fetch_rejected", {
          level: "error",
          metadata: { reason: "missing_token" },
        });
        return;
      }

      setLoading(true);
      setError(null);
      try {
        addDiagnosticsBreadcrumb("inbox_fetch_started");
        const nextIssues = await fetchInboxIssues({
          apiKey: token,
          config,
        });

        const firstIssue = nextIssues[0];
        if (firstIssue) {
          setDiagnosticsContext({
            issueId: firstIssue.id,
            issueIdentifier: firstIssue.identifier,
          });
        }

        addDiagnosticsBreadcrumb("inbox_fetch_succeeded", {
          metadata: {
            issueCount: nextIssues.length,
            topIssueIdentifier: firstIssue?.identifier ?? "none",
          },
        });

        const cached = await saveCachedIssueList(nextIssues);
        setIssues(nextIssues);
        setCacheSource("network");
        setHasSession(true);
        setSessionState("active");
        setSessionStateNote(
          config.deploymentMode === "local_trusted"
            ? "Session persisted for local_trusted mode."
            : "Authenticated mode session active (memory-only).",
        );
        setLoadedAt(cached.cachedAt);
        await saveSessionToken(config.deploymentMode, token);
        await markSessionValidated(config.deploymentMode);
      } catch (err) {
        if (
          err instanceof PaperclipApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          await invalidateSession(
            "Session expired or unauthorized token. Sign in again to continue.",
          );
        }

        const logged = recordDiagnosticsError(err, {
          metadata: {
            operation: "fetch_inbox_issues",
          },
        });

        const cached = await loadCachedIssueList();
        if (cached) {
          setIssues(cached.issues);
          setLoadedAt(cached.cachedAt);
          setCacheSource("cache");
          setError(
            `Using cached inbox data (errorId: ${logged.id}). ${getErrorMessage(err)}`,
          );
        } else {
          setError(
            err instanceof Error
              ? `${err.message} (errorId: ${logged.id})`
              : "Unknown request error.",
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [apiKey, config, hasRequiredConfig, invalidateSession],
  );

  const loadIssueContext = useCallback(
    async (issueId: string) => {
      const token = apiKey.trim();
      if (!hasRequiredConfig || token.length === 0) {
        setError("Sign in first to load issue details.");
        return;
      }

      setDetailLoading(true);
      setError(null);
      try {
        const [detail, comments] = await Promise.all([
          fetchIssueDetail({ issueId, apiKey: token, config }),
          fetchIssueComments({ issueId, apiKey: token, config }),
        ]);

        const [savedDetail, savedComments] = await Promise.all([
          saveCachedIssueDetail(detail),
          saveCachedIssueComments(issueId, comments),
        ]);

        setSelectedIssueDetail(savedDetail.detail);
        setSelectedIssueComments(savedComments.comments);
        setSelectedIssueLoadedAt(savedDetail.cachedAt);
        setSelectedIssueSource("network");
      } catch (err) {
        if (
          err instanceof PaperclipApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          await invalidateSession(
            "Issue detail request unauthorized. Session expired; sign in again.",
          );
        }

        const [cachedDetail, cachedComments] = await Promise.all([
          loadCachedIssueDetail(issueId),
          loadCachedIssueComments(issueId),
        ]);

        if (cachedDetail) {
          setSelectedIssueDetail(cachedDetail.detail);
          setSelectedIssueLoadedAt(cachedDetail.cachedAt);
          setSelectedIssueSource("cache");
          setSelectedIssueComments(cachedComments?.comments ?? []);
          setError(`Using cached issue detail. ${getErrorMessage(err)}`);
        } else {
          setError(getErrorMessage(err));
          setSelectedIssueDetail(null);
          setSelectedIssueComments([]);
          setSelectedIssueLoadedAt(null);
          setSelectedIssueSource("none");
        }
      } finally {
        setDetailLoading(false);
      }
    },
    [apiKey, config, hasRequiredConfig, invalidateSession],
  );

  const enqueueMutation = useCallback(
    async (mutation: PendingMutationDraft) => {
      const queuedMutation = materializeMutation(mutation);
      const nextQueue = [...queueRef.current, queuedMutation];
      await persistQueue(nextQueue);
      addDiagnosticsBreadcrumb("mutation_queued", {
        metadata: {
          issueId: queuedMutation.issueId,
          kind: queuedMutation.kind,
          queueSize: nextQueue.length,
        },
      });
      return queuedMutation;
    },
    [persistQueue],
  );

  const applyMutation = useCallback(
    async (mutation: PendingMutation, token: string) => {
      const request = {
        issueId: mutation.issueId,
        apiKey: token,
        config,
        runId: mutation.runId,
      };

      switch (mutation.kind) {
        case "checkout":
          await checkoutIssue(request);
          break;
        case "comment":
          await addIssueComment({
            ...request,
            body: mutation.body,
          });
          break;
        case "status":
          await updateIssueStatus({
            ...request,
            status: mutation.status,
          });
          break;
        default:
          throw new PaperclipApiError(`Unsupported mutation kind: ${describeMutation(mutation)}`);
      }
    },
    [config],
  );

  const replayDeferredMutations = useCallback(
    async (trigger: ReplayTrigger) => {
      if (replayingQueue) {
        return;
      }

      const token = apiKey.trim();
      if (token.length === 0 || queueRef.current.length === 0) {
        return;
      }

      setReplayingQueue(true);
      setError(null);

      const queued = [...queueRef.current];
      const remaining: PendingMutation[] = [];
      let appliedAny = false;

      for (let index = 0; index < queued.length; index += 1) {
        const mutation = queued[index];
        try {
          await applyMutation(mutation, token);
          appliedAny = true;
          await appendReplay(mutation, "applied", `Applied via ${trigger} replay.`);
        } catch (err) {
          if (
            err instanceof PaperclipApiError &&
            (err.status === 401 || err.status === 403)
          ) {
            await invalidateSession(
              "Replay stopped: session expired/unauthorized while applying queued mutations.",
            );
            remaining.push(mutation, ...queued.slice(index + 1));
            break;
          }

          if (isConflictError(err)) {
            await appendReplay(mutation, "conflict", getErrorMessage(err));
            continue;
          }

          const retriable = isRetriableOfflineError(err);
          const nextMutation = incrementMutationAttempts(mutation);

          if (retriable) {
            await appendReplay(
              mutation,
              "failed",
              `Deferred again (attempt ${nextMutation.attempts}). ${getErrorMessage(err)}`,
            );
            remaining.push(nextMutation);

            if (err instanceof PaperclipApiError && err.isNetworkError) {
              remaining.push(...queued.slice(index + 1));
              break;
            }
            continue;
          }

          await appendReplay(mutation, "failed", getErrorMessage(err));
        }
      }

      await persistQueue(remaining);
      setReplayingQueue(false);

      if (appliedAny) {
        await loadIssues();
        if (selectedIssueId) {
          await loadIssueContext(selectedIssueId);
        }
      }
    },
    [
      apiKey,
      appendReplay,
      applyMutation,
      invalidateSession,
      loadIssueContext,
      loadIssues,
      persistQueue,
      replayingQueue,
      selectedIssueId,
    ],
  );

  useEffect(() => {
    const previous = wasOnlineRef.current;
    if (
      previous === false &&
      isOnline &&
      hasSession &&
      mutationQueue.length > 0 &&
      !replayingQueue
    ) {
      void replayDeferredMutations("reconnect");
    }
    wasOnlineRef.current = isOnline;
  }, [hasSession, isOnline, mutationQueue.length, replayDeferredMutations, replayingQueue]);

  const runMutationOrQueue = useCallback(
    async (mutation: PendingMutationDraft) => {
      const token = apiKey.trim();
      if (token.length === 0) {
        setError("Sign in first to run mutations.");
        setSessionState("signed_out");
        setSessionStateNote("No active session token.");
        return;
      }

      if (!isOnline) {
        await enqueueMutation(mutation);
        setError("Offline mode: mutation queued for replay on reconnect.");
        return;
      }

      try {
        await applyMutation(materializeMutation(mutation, { id: "inline" }), token);
      } catch (err) {
        if (
          err instanceof PaperclipApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          await invalidateSession(
            "Mutation rejected due expired/unauthorized session. Sign in again.",
          );
          return;
        }

        if (isConflictError(err)) {
          const mutationForLog = materializeMutation(mutation);
          await appendReplay(mutationForLog, "conflict", getErrorMessage(err));
          setError(`Conflict detected: ${getErrorMessage(err)}`);
          return;
        }

        if (isRetriableOfflineError(err)) {
          await enqueueMutation(mutation);
          setError(`Request deferred: ${getErrorMessage(err)}`);
          return;
        }

        setError(getErrorMessage(err));
      }
    },
    [apiKey, applyMutation, appendReplay, enqueueMutation, invalidateSession, isOnline],
  );

  const handleAuthSubmit = useCallback(() => {
    addDiagnosticsBreadcrumb("auth_submit_pressed");
    void loadIssues();
  }, [loadIssues]);

  const handleRefresh = useCallback(() => {
    if (!hasSession) {
      return;
    }
    addDiagnosticsBreadcrumb("refresh_pressed");
    void loadIssues();
  }, [hasSession, loadIssues]);

  const handleQaFixtureAuth = useCallback(() => {
    if (!hasQaFixture) {
      setError("No QA auth fixture configured.");
      addDiagnosticsBreadcrumb("qa_fixture_auth_rejected", {
        level: "error",
        metadata: { reason: "fixture_not_configured" },
      });
      return;
    }
    setApiKey(QA_SEEDED_API_KEY);
    addDiagnosticsBreadcrumb("qa_fixture_auth_used");
    void loadIssues(QA_SEEDED_API_KEY);
  }, [hasQaFixture, loadIssues]);

  const handleToggleNotifications = useCallback(async () => {
    if (!hasRequiredConfig || notificationPreference === "loading") {
      return;
    }

    setNotificationBusy(true);
    setError(null);

    try {
      if (notificationPreference === "enabled") {
        await saveNotificationPreference(config.companyId, config.agentId, "disabled");
        setNotificationPreference("disabled");
        setNotificationStateNote("Push notifications disabled for this agent profile.");
        setExpoPushTokenPreview(null);
        addDiagnosticsBreadcrumb("notifications_opt_out");
        return;
      }

      const registration = await registerForPushNotifications();
      if (registration.permission !== "granted") {
        await saveNotificationPreference(config.companyId, config.agentId, "disabled");
        setNotificationPreference("disabled");
        setNotificationStateNote(registration.detail);
        setExpoPushTokenPreview(null);
        addDiagnosticsBreadcrumb("notifications_opt_in_rejected", {
          level: "error",
          metadata: {
            permission: registration.permission,
          },
        });
        return;
      }

      await saveNotificationPreference(config.companyId, config.agentId, "enabled");
      setNotificationPreference("enabled");
      setNotificationStateNote(registration.detail);
      setExpoPushTokenPreview(
        registration.expoPushToken ? `${registration.expoPushToken.slice(0, 12)}...` : null,
      );
      addDiagnosticsBreadcrumb("notifications_opt_in_enabled", {
        metadata: {
          tokenIssued: Boolean(registration.expoPushToken),
        },
      });
    } catch (err) {
      const logged = recordDiagnosticsError(err, {
        metadata: {
          operation: "toggle_notifications",
        },
      });
      setError(`Failed to update notification preference (errorId: ${logged.id}).`);
    } finally {
      setNotificationBusy(false);
    }
  }, [config.agentId, config.companyId, hasRequiredConfig, notificationPreference]);

  const handleSelectIssue = useCallback(
    (issueId: string) => {
      setSelectedIssueId(issueId);
      setCommentDraft("");
      void loadIssueContext(issueId);
    },
    [loadIssueContext],
  );

  const focusIssueFromWakeSignal = useCallback(
    async (signal: {
      issueId: string | null;
      issueIdentifier: string | null;
      source: "notification" | "deep_link";
    }) => {
      let nextIssueId = signal.issueId;
      if (!nextIssueId && signal.issueIdentifier) {
        const match = issues.find((issue) => issue.identifier === signal.issueIdentifier);
        nextIssueId = match?.id ?? null;
      }

      if (!nextIssueId) {
        await loadIssues();
        return;
      }

      setSelectedIssueId(nextIssueId);
      setCommentDraft("");
      setDiagnosticsContext({
        issueId: nextIssueId,
        issueIdentifier: signal.issueIdentifier ?? undefined,
      });
      addDiagnosticsBreadcrumb("wake_signal_routed", {
        metadata: {
          source: signal.source,
          hasIssueIdentifier: Boolean(signal.issueIdentifier),
        },
      });
      await loadIssueContext(nextIssueId);
    },
    [issues, loadIssueContext, loadIssues],
  );

  useEffect(() => {
    const handleDeepLink = (url: string) => {
      const issueId = extractIssueIdFromDeepLink(url);
      if (!issueId) {
        return;
      }
      void focusIssueFromWakeSignal({
        issueId,
        issueIdentifier: null,
        source: "deep_link",
      });
    };

    void Linking.getInitialURL().then((initialUrl) => {
      if (initialUrl) {
        handleDeepLink(initialUrl);
      }
    });

    const linkSub = Linking.addEventListener("url", ({ url }) => {
      handleDeepLink(url);
    });

    return () => {
      linkSub.remove();
    };
  }, [focusIssueFromWakeSignal]);

  useEffect(() => {
    const routeResponse = (response: Notifications.NotificationResponse) => {
      const payload = parseIssueWakePayload(
        response.notification.request.content.data as Record<string, unknown>,
      );
      if (!payload) {
        return;
      }

      if (payload.deepLink) {
        const issueIdFromDeepLink = extractIssueIdFromDeepLink(payload.deepLink);
        void focusIssueFromWakeSignal({
          issueId: issueIdFromDeepLink ?? payload.issueId,
          issueIdentifier: payload.issueIdentifier,
          source: "notification",
        });
        return;
      }

      void focusIssueFromWakeSignal({
        issueId: payload.issueId,
        issueIdentifier: payload.issueIdentifier,
        source: "notification",
      });
    };

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        routeResponse(response);
      }
    });

    const sub = Notifications.addNotificationResponseReceivedListener(routeResponse);
    return () => {
      sub.remove();
    };
  }, [focusIssueFromWakeSignal]);

  const handleCheckoutSelected = useCallback(async () => {
    if (!selectedIssueId) {
      return;
    }

    await runMutationOrQueue({
      kind: "checkout",
      issueId: selectedIssueId,
      runId: sessionRunId,
    });

    await loadIssues();
    await loadIssueContext(selectedIssueId);
  }, [loadIssueContext, loadIssues, runMutationOrQueue, selectedIssueId, sessionRunId]);

  const handleSetStatus = useCallback(
    async (status: IssueStatus) => {
      if (!selectedIssueId) {
        return;
      }

      await runMutationOrQueue({
        kind: "status",
        issueId: selectedIssueId,
        status,
        runId: sessionRunId,
      });

      await loadIssues();
      await loadIssueContext(selectedIssueId);
    },
    [loadIssueContext, loadIssues, runMutationOrQueue, selectedIssueId, sessionRunId],
  );

  const handleSubmitComment = useCallback(async () => {
    const trimmed = commentDraft.trim();
    if (!selectedIssueId || trimmed.length === 0) {
      return;
    }

    await runMutationOrQueue({
      kind: "comment",
      issueId: selectedIssueId,
      body: trimmed,
      runId: sessionRunId,
    });

    setCommentDraft("");
    await loadIssueContext(selectedIssueId);
  }, [commentDraft, loadIssueContext, runMutationOrQueue, selectedIssueId, sessionRunId]);

  const handleReplayQueue = useCallback(() => {
    void replayDeferredMutations("manual");
  }, [replayDeferredMutations]);

  const buildDiagnosticsReport = useCallback(() => {
    addDiagnosticsBreadcrumb("diagnostics_report_generated", {
      metadata: {
        issueCount: issues.length,
        hasSession,
        isOnline,
        queuedMutations: mutationQueue.length,
      },
    });
    const report = getDiagnosticsSnapshotText();
    setDiagnosticsPreview(report.slice(0, 1100));
    setDiagnosticsGeneratedAt(new Date().toISOString());
    return report;
  }, [hasSession, isOnline, issues.length, mutationQueue.length]);

  const handleShareDiagnostics = useCallback(async () => {
    setSharingDiagnostics(true);
    try {
      const report = buildDiagnosticsReport();
      await Share.share({
        title: "Paperclip Mobile diagnostics",
        message: report,
      });
      addDiagnosticsBreadcrumb("diagnostics_report_shared");
    } catch (err) {
      const logged = recordDiagnosticsError(err, {
        metadata: {
          operation: "share_diagnostics_report",
        },
      });
      setError(`Failed to share diagnostics report (errorId: ${logged.id}).`);
    } finally {
      setSharingDiagnostics(false);
    }
  }, [buildDiagnosticsReport]);

  const handlePreviewDiagnostics = useCallback(() => {
    if (!diagnosticsPreview) {
      buildDiagnosticsReport();
    }
    setShowDiagnosticsPreview((current) => !current);
  }, [buildDiagnosticsReport, diagnosticsPreview]);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Paperclip Inbox</Text>
          <Text style={styles.subtitle}>Offline-ready Android shell</Text>
          <Text style={styles.config}>{configText}</Text>
          <Text style={styles.meta}>Run ID: {sessionRunId}</Text>
        </View>

        <View
          style={[
            styles.connectivityBanner,
            isOnline ? styles.connectivityOnline : styles.connectivityOffline,
          ]}
          testID={TEST_IDS.offlineBanner}
        >
          <Text style={styles.connectivityText}>
            {isOnline ? "Online" : "Offline"} · queue {mutationQueue.length}
          </Text>
          {lastConnectivityCheckAt ? (
            <Text style={styles.connectivityMeta}>
              Last check: {formatTimestamp(lastConnectivityCheckAt)}
            </Text>
          ) : null}
        </View>

        <View style={styles.authPanel} testID={TEST_IDS.authForm}>
          <Text style={styles.inputLabel}>Bearer token</Text>
          <TextInput
            testID={TEST_IDS.authTokenInput}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="Paste Paperclip API key"
            placeholderTextColor="#8B8E96"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Text style={styles.meta}>Auth mode: {config.deploymentMode}</Text>
          <Text style={styles.meta}>Session state: {sessionState}</Text>
          {sessionStateNote ? (
            <Text style={styles.sessionNote}>{sessionStateNote}</Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              testID={TEST_IDS.authSubmitButton}
              onPress={handleAuthSubmit}
              style={[styles.button, !canSubmitAuth && styles.buttonDisabled]}
              disabled={!canSubmitAuth}
            >
              <Text style={styles.buttonText}>{loading ? "Loading..." : "Sign in"}</Text>
            </Pressable>
            <Pressable
              testID={TEST_IDS.refreshAction}
              onPress={handleRefresh}
              style={[styles.buttonSecondary, !canRefresh && styles.buttonDisabled]}
              disabled={!canRefresh}
            >
              <Text style={styles.buttonSecondaryText}>Refresh inbox</Text>
            </Pressable>
          </View>
          {hasQaFixture ? (
            <Pressable
              testID={TEST_IDS.qaFixtureButton}
              onPress={handleQaFixtureAuth}
              style={[styles.buttonGhost, loading && styles.buttonDisabled]}
              disabled={loading}
            >
              <Text style={styles.buttonGhostText}>Use QA fixture token</Text>
            </Pressable>
          ) : null}
          <View style={styles.queueRow}>
            <Text style={styles.queueText} testID={TEST_IDS.mutationQueueCount}>
              Deferred mutations: {mutationQueue.length}
            </Text>
            <Pressable
              testID={TEST_IDS.replayQueueButton}
              onPress={handleReplayQueue}
              style={[
                styles.buttonGhost,
                (!isOnline || replayingQueue || mutationQueue.length === 0) && styles.buttonDisabled,
              ]}
              disabled={!isOnline || replayingQueue || mutationQueue.length === 0}
            >
              <Text style={styles.buttonGhostText}>
                {replayingQueue ? "Replaying..." : "Replay queue"}
              </Text>
            </Pressable>
          </View>
          <View style={styles.queueRow}>
            <Text style={styles.queueText} testID={TEST_IDS.notificationsState}>
              Notifications:{" "}
              {notificationPreference === "loading"
                ? "loading..."
                : notificationPreference === "enabled"
                  ? "enabled"
                  : "disabled"}
            </Text>
            <Pressable
              testID={TEST_IDS.notificationsToggle}
              onPress={() => {
                void handleToggleNotifications();
              }}
              style={[
                styles.buttonGhost,
                (!canToggleNotifications || notificationBusy) && styles.buttonDisabled,
              ]}
              disabled={!canToggleNotifications || notificationBusy}
            >
              <Text style={styles.buttonGhostText}>
                {notificationBusy
                  ? "Updating..."
                  : notificationPreference === "enabled"
                    ? "Disable push"
                    : "Enable push"}
              </Text>
            </Pressable>
          </View>
          {notificationStateNote ? (
            <Text style={styles.sessionNote}>{notificationStateNote}</Text>
          ) : null}
          {expoPushTokenPreview ? (
            <Text style={styles.meta}>Expo push token: {expoPushTokenPreview}</Text>
          ) : null}
        </View>

        {error ? (
          <View testID={TEST_IDS.errorState}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.loader}>
            <ActivityIndicator size="large" color="#F97316" />
          </View>
        ) : null}

        {loadedAt ? (
          <Text style={styles.meta}>
            Last inbox sync: {formatTimestamp(loadedAt)} ({cacheSource})
          </Text>
        ) : null}

        <View style={styles.listContainer} testID={TEST_IDS.issueListContainer}>
          <View style={styles.filterBar}>
            {INBOX_STATUS_FILTERS.map((filterOption) => (
              <Pressable
                key={filterOption.key}
                testID={filterOption.testId}
                onPress={() => {
                  setInboxStatusFilter(filterOption.key);
                }}
                style={[
                  styles.filterChip,
                  inboxStatusFilter === filterOption.key && styles.filterChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    inboxStatusFilter === filterOption.key &&
                      styles.filterChipTextActive,
                  ]}
                >
                  {filterOption.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.meta}>
            Sorted by priority then recency · showing {filteredIssues.length} ({formatStatusChipLabel(inboxStatusFilter)})
          </Text>
          <FlatList
            testID={TEST_IDS.issueList}
            data={filteredIssues}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <Text testID={TEST_IDS.emptyState} style={styles.empty}>
                {loadedAt
                  ? `No issues for ${formatStatusChipLabel(inboxStatusFilter)}.`
                  : "No data loaded yet."}
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  handleSelectIssue(item.id);
                }}
                style={[
                  styles.issueCard,
                  selectedIssueId === item.id && styles.issueCardSelected,
                ]}
                testID={`${TEST_IDS.issueCardPrefix}${item.id}`}
              >
                <View style={styles.row}>
                  <Text style={styles.identifier}>{item.identifier}</Text>
                  <Text style={styles.badge}>{item.priority.toUpperCase()}</Text>
                </View>
                <Text style={styles.issueTitle}>{item.title}</Text>
                <Text style={styles.meta}>Status: {item.status}</Text>
                <Text style={styles.meta}>Updated: {formatTimestamp(item.updatedAt)}</Text>
              </Pressable>
            )}
          />
        </View>

        <View style={styles.issueDetailPanel} testID={TEST_IDS.issueDetailPanel}>
          <Text style={styles.panelTitle}>Issue detail + offline actions</Text>
          {!selectedIssueId ? (
            <Text style={styles.meta}>Select an issue from the inbox to inspect details and queue writes.</Text>
          ) : detailLoading ? (
            <ActivityIndicator size="small" color="#F97316" />
          ) : selectedIssueDetail ? (
            <>
              <Text style={styles.issueTitle}>{selectedIssueDetail.identifier}</Text>
              <Text style={styles.meta}>Status: {selectedIssueDetail.status}</Text>
              <Text style={styles.meta}>Source: {selectedIssueSource}</Text>
              {selectedIssueLoadedAt ? (
                <Text style={styles.meta}>Detail synced: {formatTimestamp(selectedIssueLoadedAt)}</Text>
              ) : null}
              {selectedIssueDetail.description ? (
                <Text style={styles.detailBody}>{selectedIssueDetail.description}</Text>
              ) : (
                <Text style={styles.meta}>No description.</Text>
              )}
              <View style={styles.contextBox}>
                <Text style={styles.commentsTitle}>Execution + traceability context</Text>
                <Text style={styles.meta}>
                  Assignee (agent): {formatOptionalId(selectedIssueDetail.assigneeAgentId)}
                </Text>
                <Text style={styles.meta}>
                  Assignee (user): {formatOptionalId(selectedIssueDetail.assigneeUserId)}
                </Text>
                <Text style={styles.meta}>
                  Active run: {formatOptionalId(selectedIssueDetail.executionRunId)}
                </Text>
                <Text style={styles.meta}>
                  Checkout run: {formatOptionalId(selectedIssueDetail.checkoutRunId)}
                </Text>
                <Text style={styles.meta}>
                  Run lock: {formatOptionalTimestamp(selectedIssueDetail.executionLockedAt)}
                </Text>
                <Text style={styles.meta}>
                  Execution agent key: {selectedIssueDetail.executionAgentNameKey ?? "Not available"}
                </Text>
                <Text style={styles.meta}>
                  Wake reason: {selectedIssueDetail.wakeReason ?? "Not available"}
                </Text>
                <Text style={styles.meta}>
                  Wake task: {formatOptionalId(selectedIssueDetail.wakeTaskId)}
                </Text>
                <Text style={styles.meta}>
                  Wake comment: {formatOptionalId(selectedIssueDetail.wakeCommentId)}
                </Text>
                <Text style={styles.meta}>Goal: {formatOptionalId(selectedIssueDetail.goalId)}</Text>
                <Text style={styles.meta}>Parent: {formatOptionalId(selectedIssueDetail.parentId)}</Text>
                <Text style={styles.meta}>
                  Project: {formatOptionalId(selectedIssueDetail.projectId)}
                </Text>
                <Text style={styles.meta}>
                  Started: {formatOptionalTimestamp(selectedIssueDetail.startedAt)}
                </Text>
                <Text style={styles.meta}>
                  Completed: {formatOptionalTimestamp(selectedIssueDetail.completedAt)}
                </Text>
              </View>

              <View style={styles.actionsWrap}>
                <Pressable
                  testID={TEST_IDS.checkoutAction}
                  onPress={() => {
                    void handleCheckoutSelected();
                  }}
                  style={styles.buttonSecondaryCompact}
                >
                  <Text style={styles.buttonSecondaryText}>Checkout</Text>
                </Pressable>
                <Pressable
                  testID={TEST_IDS.setStatusInProgressAction}
                  onPress={() => {
                    void handleSetStatus("in_progress");
                  }}
                  style={styles.buttonSecondaryCompact}
                >
                  <Text style={styles.buttonSecondaryText}>Set in progress</Text>
                </Pressable>
                <Pressable
                  testID={TEST_IDS.setStatusDoneAction}
                  onPress={() => {
                    void handleSetStatus("done");
                  }}
                  style={styles.buttonSecondaryCompact}
                >
                  <Text style={styles.buttonSecondaryText}>Set done</Text>
                </Pressable>
              </View>

              <TextInput
                testID={TEST_IDS.issueCommentInput}
                value={commentDraft}
                onChangeText={setCommentDraft}
                placeholder="Write a comment (queued offline)"
                placeholderTextColor="#8B8E96"
                autoCapitalize="sentences"
                multiline
                style={styles.commentInput}
              />
              <Pressable
                testID={TEST_IDS.issueCommentSubmit}
                onPress={() => {
                  void handleSubmitComment();
                }}
                style={styles.buttonSecondaryCompact}
                disabled={commentDraft.trim().length === 0}
              >
                <Text style={styles.buttonSecondaryText}>Post comment</Text>
              </Pressable>

              <View testID={TEST_IDS.issueDetailComments} style={styles.commentsBox}>
                <Text style={styles.commentsTitle}>Comments</Text>
                {selectedIssueComments.length === 0 ? (
                  <Text style={styles.meta}>No comments cached yet.</Text>
                ) : (
                  selectedIssueComments.slice(0, 5).map((comment) => (
                    <View key={comment.id} style={styles.commentRow}>
                      <Text style={styles.commentMeta}>
                        {formatTimestamp(comment.createdAt)} · {comment.authorAgentId ? "agent" : "user"}
                      </Text>
                      <Text style={styles.commentBody}>{comment.body}</Text>
                    </View>
                  ))
                )}
              </View>
            </>
          ) : (
            <Text style={styles.meta}>No detail available yet.</Text>
          )}
        </View>

        <View style={styles.replayPanel}>
          <Text style={styles.panelTitle}>Replay results</Text>
          {replayResults.length === 0 ? (
            <Text style={styles.meta}>No replay attempts yet.</Text>
          ) : (
            replayResults.slice(0, 4).map((result) => (
              <View key={result.id} style={styles.replayRow}>
                <Text style={styles.replayOutcome}>{result.outcome.toUpperCase()}</Text>
                <Text style={styles.replayMessage}>
                  {formatTimestamp(result.createdAt)} · {result.kind} · {result.message}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={styles.diagnosticsPanel} testID={TEST_IDS.diagnosticsPanel}>
          <Text style={styles.diagnosticsTitle}>QA diagnostics</Text>
          <Text style={styles.diagnosticsNote}>
            Export includes redacted run, connectivity, and replay breadcrumbs.
          </Text>
          <View style={styles.diagnosticsActions}>
            <Pressable
              testID={TEST_IDS.diagnosticsShareButton}
              onPress={() => {
                void handleShareDiagnostics();
              }}
              style={[styles.buttonSecondary, sharingDiagnostics && styles.buttonDisabled]}
              disabled={sharingDiagnostics}
            >
              <Text style={styles.buttonSecondaryText}>
                {sharingDiagnostics ? "Preparing..." : "Share diagnostics"}
              </Text>
            </Pressable>
            <Pressable
              testID={TEST_IDS.diagnosticsPreviewButton}
              onPress={handlePreviewDiagnostics}
              style={styles.buttonGhost}
            >
              <Text style={styles.buttonGhostText}>
                {showDiagnosticsPreview ? "Hide preview" : "Preview JSON"}
              </Text>
            </Pressable>
          </View>
          {diagnosticsGeneratedAt ? (
            <Text style={styles.meta}>Last diagnostics: {formatTimestamp(diagnosticsGeneratedAt)}</Text>
          ) : null}
          {showDiagnosticsPreview && diagnosticsPreview ? (
            <Text style={styles.diagnosticsPreview}>{diagnosticsPreview}</Text>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0F172A",
  },
  container: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    gap: 10,
  },
  header: {
    gap: 4,
  },
  title: {
    color: "#F8FAFC",
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    color: "#CBD5E1",
    fontSize: 14,
  },
  config: {
    color: "#94A3B8",
    fontSize: 12,
  },
  connectivityBanner: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  connectivityOnline: {
    backgroundColor: "#10261A",
    borderColor: "#1D7A46",
  },
  connectivityOffline: {
    backgroundColor: "#2A1812",
    borderColor: "#9A3412",
  },
  connectivityText: {
    color: "#E2E8F0",
    fontSize: 12,
    fontWeight: "700",
  },
  connectivityMeta: {
    color: "#94A3B8",
    fontSize: 11,
    marginTop: 2,
  },
  authPanel: {
    backgroundColor: "#111827",
    borderColor: "#1F2937",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  inputLabel: {
    color: "#E2E8F0",
    fontSize: 13,
    fontWeight: "600",
  },
  input: {
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    color: "#F8FAFC",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#0B1220",
  },
  commentInput: {
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    color: "#F8FAFC",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#0B1220",
    minHeight: 70,
    textAlignVertical: "top",
  },
  actions: {
    flexDirection: "row",
    gap: 8,
  },
  queueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  queueText: {
    color: "#CBD5E1",
    fontSize: 12,
    flex: 1,
  },
  sessionNote: {
    color: "#93C5FD",
    fontSize: 11,
    lineHeight: 15,
  },
  button: {
    backgroundColor: "#F97316",
    borderRadius: 10,
    paddingVertical: 11,
    flex: 1,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: "#1F2937",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 11,
    flex: 1,
    alignItems: "center",
  },
  buttonSecondaryCompact: {
    backgroundColor: "#1F2937",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: "center",
  },
  buttonGhost: {
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: "#0B1220",
    fontWeight: "700",
  },
  buttonSecondaryText: {
    color: "#E2E8F0",
    fontWeight: "700",
    fontSize: 12,
  },
  buttonGhostText: {
    color: "#94A3B8",
    fontWeight: "600",
    fontSize: 12,
  },
  error: {
    color: "#FCA5A5",
    fontSize: 13,
  },
  loader: {
    alignItems: "center",
  },
  listContainer: {
    maxHeight: 220,
    gap: 8,
  },
  filterBar: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  filterChip: {
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#0B1220",
  },
  filterChipActive: {
    borderColor: "#F97316",
    backgroundColor: "#2A1A12",
  },
  filterChipText: {
    color: "#94A3B8",
    fontSize: 11,
    fontWeight: "600",
  },
  filterChipTextActive: {
    color: "#FDBA74",
  },
  listContent: {
    gap: 10,
    paddingBottom: 12,
  },
  issueCard: {
    backgroundColor: "#111827",
    borderColor: "#1F2937",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  issueCardSelected: {
    borderColor: "#F97316",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  identifier: {
    color: "#FDBA74",
    fontSize: 13,
    fontWeight: "700",
  },
  badge: {
    color: "#38BDF8",
    fontSize: 11,
    fontWeight: "700",
  },
  issueTitle: {
    color: "#F1F5F9",
    fontSize: 15,
    fontWeight: "600",
  },
  meta: {
    color: "#94A3B8",
    fontSize: 12,
  },
  empty: {
    color: "#94A3B8",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 16,
  },
  issueDetailPanel: {
    backgroundColor: "#111827",
    borderColor: "#1F2937",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  panelTitle: {
    color: "#E2E8F0",
    fontSize: 13,
    fontWeight: "700",
  },
  detailBody: {
    color: "#CBD5E1",
    fontSize: 12,
    lineHeight: 18,
  },
  actionsWrap: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  contextBox: {
    backgroundColor: "#0B1220",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 6,
  },
  commentsBox: {
    backgroundColor: "#0B1220",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  commentsTitle: {
    color: "#E2E8F0",
    fontSize: 12,
    fontWeight: "700",
  },
  commentRow: {
    gap: 4,
  },
  commentMeta: {
    color: "#94A3B8",
    fontSize: 11,
  },
  commentBody: {
    color: "#CBD5E1",
    fontSize: 12,
  },
  replayPanel: {
    backgroundColor: "#111827",
    borderColor: "#1F2937",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  replayRow: {
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 3,
  },
  replayOutcome: {
    color: "#F8FAFC",
    fontSize: 11,
    fontWeight: "700",
  },
  replayMessage: {
    color: "#CBD5E1",
    fontSize: 11,
  },
  diagnosticsPanel: {
    backgroundColor: "#111827",
    borderColor: "#1F2937",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
    marginBottom: 8,
  },
  diagnosticsTitle: {
    color: "#E2E8F0",
    fontSize: 13,
    fontWeight: "700",
  },
  diagnosticsNote: {
    color: "#94A3B8",
    fontSize: 12,
  },
  diagnosticsActions: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  diagnosticsPreview: {
    color: "#CBD5E1",
    fontSize: 10,
    lineHeight: 15,
    fontFamily: "monospace",
  },
});
