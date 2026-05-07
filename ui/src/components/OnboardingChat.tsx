import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyPortabilityFileEntry,
  IssueComment,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  RequestConfirmationIssueDocumentTarget,
} from "@paperclipai/shared";
import { useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { Loader2 } from "lucide-react";
import { OnboardingChrome } from "./OnboardingChrome";
import { OnboardingStepTabs } from "./OnboardingStepTabs";
import { COACH_STEP_TABS } from "./onboarding-coach-steps";

const POLL_INTERVAL_MS = 4000;
const COACH_RESPONSE_GRACE_MS = 1500;
const COACH_PACKAGE_DOCUMENT_KEY = "coach-package";

type ChatBubble = {
  id: string;
  side: "coach" | "you";
  body: string;
  createdAt: Date;
};

function classifyComment(
  comment: IssueComment,
  coachAgentId: string | null,
): ChatBubble | null {
  const side: ChatBubble["side"] | null = (() => {
    if (coachAgentId && comment.authorAgentId === coachAgentId) return "coach";
    if (comment.authorUserId) return "you";
    if (comment.authorAgentId) return "coach";
    return null;
  })();
  if (!side) return null;
  return {
    id: comment.id,
    side,
    body: comment.body,
    createdAt: comment.createdAt instanceof Date ? comment.createdAt : new Date(comment.createdAt),
  };
}

function findPendingLaunchConfirmation(
  interactions: IssueThreadInteraction[] | undefined,
): RequestConfirmationInteraction | null {
  if (!interactions) return null;
  for (const interaction of interactions) {
    if (interaction.kind !== "request_confirmation") continue;
    if (interaction.status !== "pending") continue;
    const target = interaction.payload.target;
    if (!target || target.type !== "issue_document") continue;
    const docTarget = target as RequestConfirmationIssueDocumentTarget;
    if (docTarget.key !== COACH_PACKAGE_DOCUMENT_KEY) continue;
    return interaction as RequestConfirmationInteraction;
  }
  return null;
}

function parsePackageDocument(body: string): Record<string, CompanyPortabilityFileEntry> | null {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return null;
    const files = (parsed as { files?: unknown }).files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return null;
    return files as Record<string, CompanyPortabilityFileEntry>;
  } catch {
    return null;
  }
}

export function OnboardingChat() {
  const params = useParams<{ companyPrefix?: string; issueRef?: string }>();
  const issueRef = params.issueRef;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setSelectedCompanyId, companies } = useCompany();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const lastSendAtRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueRef ?? ""),
    queryFn: () => issuesApi.get(issueRef!),
    enabled: Boolean(issueRef),
  });
  const issue = issueQuery.data ?? null;
  const issueId = issue?.id ?? null;
  const coachAgentId = issue?.assigneeAgentId ?? null;

  useEffect(() => {
    if (issue?.companyId) setSelectedCompanyId(issue.companyId);
  }, [issue?.companyId, setSelectedCompanyId]);

  const commentsQuery = useQuery({
    queryKey: ["onboarding-chat", "comments", issueId],
    queryFn: () => issuesApi.listComments(issueId!, { order: "asc", limit: 200 }),
    enabled: Boolean(issueId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const interactionsQuery = useQuery({
    queryKey: ["onboarding-chat", "interactions", issueId],
    queryFn: () => issuesApi.listInteractions(issueId!),
    enabled: Boolean(issueId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const coachQuery = useQuery({
    queryKey: queryKeys.agents.detail(coachAgentId ?? ""),
    queryFn: () => agentsApi.get(coachAgentId!),
    enabled: Boolean(coachAgentId),
    refetchInterval: POLL_INTERVAL_MS,
  });
  const coach = coachQuery.data ?? null;

  const company = useMemo(
    () => (issue ? companies.find((c) => c.id === issue.companyId) ?? null : null),
    [issue, companies],
  );

  const bubbles = useMemo(() => {
    const raw = commentsQuery.data ?? [];
    return raw
      .map((c) => classifyComment(c, coachAgentId))
      .filter((b): b is ChatBubble => b !== null);
  }, [commentsQuery.data, coachAgentId]);

  const launchConfirmation = useMemo(
    () => findPendingLaunchConfirmation(interactionsQuery.data),
    [interactionsQuery.data],
  );

  const coachThinking = useMemo(() => {
    if (launchConfirmation) return false;
    const lastBubble = bubbles[bubbles.length - 1];
    const userJustSent = lastBubble?.side === "you";
    const agentRunning = coach?.status === "running";
    const sinceSendOk = Date.now() - lastSendAtRef.current >= COACH_RESPONSE_GRACE_MS;
    return (userJustSent || agentRunning) && sinceSendOk && !sending;
  }, [launchConfirmation, bubbles, coach?.status, sending]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [bubbles.length, coachThinking, launchConfirmation?.id]);

  async function handleSend() {
    if (!issueId || !draft.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await issuesApi.addComment(issueId, draft.trim());
      lastSendAtRef.current = Date.now();
      setDraft("");
      await queryClient.invalidateQueries({
        queryKey: ["onboarding-chat", "comments", issueId],
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleLaunch() {
    if (!issueId || !issue || !launchConfirmation || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const doc = await issuesApi.getDocument(issueId, COACH_PACKAGE_DOCUMENT_KEY);
      const files = parsePackageDocument(doc.body);
      if (!files || Object.keys(files).length === 0) {
        throw new Error(
          "The Coach's package document is empty or malformed. Ask the Coach to rewrite it.",
        );
      }

      await companiesApi.applyImportToCompany(issue.companyId, {
        source: { type: "inline", files },
        target: { mode: "existing_company", companyId: issue.companyId },
        collisionStrategy: "skip",
      });

      await companiesApi.update(issue.companyId, { status: "active" });

      await issuesApi.acceptInteraction(issueId, launchConfirmation.id);

      const targetCompany =
        companies.find((c) => c.id === issue.companyId) ?? company;
      const prefix = targetCompany?.issuePrefix ?? params.companyPrefix ?? "";
      navigate(`/${prefix}/dashboard`);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : "Failed to launch");
    } finally {
      setLaunching(false);
    }
  }

  async function handleHoldOn() {
    if (!issueId || !launchConfirmation || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      await issuesApi.rejectInteraction(issueId, launchConfirmation.id);
      await queryClient.invalidateQueries({
        queryKey: ["onboarding-chat", "interactions", issueId],
      });
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : "Failed to send rejection");
    } finally {
      setLaunching(false);
    }
  }

  if (!issueRef) {
    return (
      <OnboardingChrome showAnimation={false}>
        <div className="mx-auto max-w-2xl py-10 text-sm text-muted-foreground">
          No onboarding chat selected.
        </div>
      </OnboardingChrome>
    );
  }

  if (issueQuery.isLoading) {
    return (
      <OnboardingChrome showAnimation={false}>
        <div className="mx-auto max-w-2xl py-10 text-sm text-muted-foreground flex items-center gap-2 px-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your Coach…
        </div>
      </OnboardingChrome>
    );
  }

  if (issueQuery.isError || !issue) {
    return (
      <OnboardingChrome showAnimation={false}>
        <div className="mx-auto max-w-2xl py-10 px-4">
          <div className="rounded-lg border border-border bg-card p-6">
            <h1 className="text-lg font-semibold">Couldn't open the onboarding chat</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {issueQuery.error instanceof Error ? issueQuery.error.message : "Unknown error"}
            </p>
            <div className="mt-4">
              <Button variant="outline" onClick={() => navigate("/onboarding")}>
                Restart onboarding
              </Button>
            </div>
          </div>
        </div>
      </OnboardingChrome>
    );
  }

  const heading = company?.name && company.name !== "Untitled"
    ? `Onboarding — ${company.name}`
    : "Talking with your Coach";

  return (
    <OnboardingChrome showAnimation={false}>
    <div className="mx-auto flex h-full max-w-2xl flex-col px-4 py-6">
      <OnboardingStepTabs
        items={COACH_STEP_TABS}
        activeId="chat"
        onSelect={(id) => {
          if (id === "configure") navigate("/onboarding");
        }}
      />
      <div className="mb-4">
        <h1 className="text-base font-medium">{heading}</h1>
        <p className="text-[11px] text-muted-foreground">
          Your Coach asks questions to help shape your company. Answer freely; the conversation is just between you and the Coach.
        </p>
        <p className="text-[11px] text-muted-foreground mt-1">
          Prefer to fill out a form?{" "}
          <a href="/onboarding/classic" className="underline">
            Switch to classic onboarding
          </a>
          {" "}— this Coach conversation will stay here as a draft.
        </p>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-lg border border-border bg-card p-4 space-y-3"
      >
        {bubbles.length === 0 && !coachThinking && !launchConfirmation ? (
          <p className="text-sm text-muted-foreground">
            Your Coach is getting set up. The first question will appear in a moment…
          </p>
        ) : null}
        {bubbles.map((bubble) => (
          <div
            key={bubble.id}
            className={cn(
              "flex",
              bubble.side === "you" ? "justify-end" : "justify-start",
            )}
          >
            <div
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                bubble.side === "you"
                  ? "bg-foreground text-background"
                  : "bg-muted text-foreground",
              )}
            >
              {bubble.body}
            </div>
          </div>
        ))}
        {coachThinking ? (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground italic">
              Coach is thinking…
            </div>
          </div>
        ) : null}
        {launchConfirmation ? (
          <div className="flex justify-start">
            <div className="w-full rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div className="text-sm font-medium">{launchConfirmation.payload.prompt}</div>
              {launchConfirmation.payload.detailsMarkdown ? (
                <div className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {launchConfirmation.payload.detailsMarkdown}
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Button onClick={handleLaunch} disabled={launching}>
                  {launching ? "Launching…" : (launchConfirmation.payload.acceptLabel ?? "Launch")}
                </Button>
                <Button variant="outline" onClick={handleHoldOn} disabled={launching}>
                  {launchConfirmation.payload.rejectLabel ?? "Hold on"}
                </Button>
              </div>
              {launchError ? (
                <p className="text-sm text-red-600">{launchError}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3">
        <textarea
          className="w-full resize-none rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 min-h-[60px]"
          placeholder={
            bubbles.length === 0
              ? "Wait for your Coach to ask the first question…"
              : "Reply to your Coach…"
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending || launching}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            Enter to send. Shift-Enter for a new line.
          </p>
          <Button onClick={handleSend} disabled={!draft.trim() || sending || launching}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
        {sendError ? (
          <p className="mt-2 text-sm text-red-600">{sendError}</p>
        ) : null}
      </div>
    </div>
    </OnboardingChrome>
  );
}
