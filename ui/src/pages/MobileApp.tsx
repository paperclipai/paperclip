import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchMobileAgents,
  fetchMobileChatMessages,
  fetchMobileIssues,
  fetchMobileSummary,
  loginMobile,
  logoutMobile,
  MobileApiError,
  postMobileChatMessage,
  type MobileAgentRow,
  type MobileChatMessage,
  type MobileIssueRow,
  type MobileIssueStatus,
  type MobileSummary,
} from "@/mobile/api";

const statusLabels: Record<MobileIssueStatus, string> = {
  running: "진행 중",
  review_needed: "검토 필요",
  blocked: "막힘",
  done: "완료",
  unknown: "알 수 없음",
};

const statusClasses: Record<MobileIssueStatus, string> = {
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-200",
  review_needed: "bg-amber-500/15 text-amber-700 dark:text-amber-200",
  blocked: "bg-red-500/15 text-red-700 dark:text-red-200",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200",
  unknown: "bg-slate-500/15 text-slate-700 dark:text-slate-200",
};

const agentStatusClasses: Record<MobileAgentRow["status"], string> = {
  idle: "bg-slate-500/15 text-slate-700 dark:text-slate-200",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-200",
  error: "bg-red-500/15 text-red-700 dark:text-red-200",
  blocked: "bg-amber-500/15 text-amber-700 dark:text-amber-200",
  unknown: "bg-slate-500/15 text-slate-700 dark:text-slate-200",
};

const agentStatusLabels: Record<MobileAgentRow["status"], string> = {
  idle: "대기",
  running: "실행",
  error: "오류",
  blocked: "막힘",
  unknown: "알 수 없음",
};

function formatRelative(value: string | null): string {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function mobileErrorMessage(error: unknown): string {
  if (error instanceof MobileApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "요청 처리 중 오류가 발생했습니다.";
}

function LoginPanel({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [token, setToken] = useState("");
  const login = useMutation({
    mutationFn: (mobileToken: string) => loginMobile(mobileToken),
    onSuccess: onLoggedIn,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate(token);
  };

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-50">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col justify-center">
        <div className="rounded-[2rem] border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-black/40 backdrop-blur">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-blue-200">Her × Pepper Mobile</p>
          <h1 className="mt-4 text-3xl font-bold leading-tight">헤르와 페퍼 작업상황을 폰에서 바로 확인합니다.</h1>
          <p className="mt-3 text-base leading-7 text-slate-300">
            모바일 토큰으로 로그인하면 실행 현황, 막힌 이슈, 에이전트 상태, 헤르 전달용 채팅 큐를 한 화면에서 봅니다.
          </p>
          <form onSubmit={submit} className="mt-8 space-y-3">
            <label className="block text-sm font-medium text-slate-200" htmlFor="mobile-token">
              모바일 접근 토큰
            </label>
            <input
              id="mobile-token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="MOBILE_APP_TOKEN"
              className="h-12 w-full rounded-2xl border border-white/10 bg-slate-900 px-4 text-base text-white outline-none ring-blue-400/40 transition focus:ring-4"
            />
            {login.isError ? <p className="text-sm text-red-300">{mobileErrorMessage(login.error)}</p> : null}
            <button
              type="submit"
              disabled={!token.trim() || login.isPending}
              className="h-12 w-full rounded-2xl bg-blue-500 text-base font-semibold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {login.isPending ? "로그인 중..." : "모바일 대시보드 열기"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

function SummaryCard({ summary }: { summary: MobileSummary }) {
  const healthLabel = summary.health === "ok" ? "정상" : summary.health === "degraded" ? "주의" : "오류";
  return (
    <section className="rounded-[1.75rem] bg-slate-950 p-5 text-white shadow-xl shadow-slate-950/15">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-300">현재 상태</p>
          <h2 className="mt-1 text-3xl font-bold">{healthLabel}</h2>
        </div>
        <span className="rounded-full bg-white/10 px-3 py-1 text-sm font-medium">페퍼</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Metric label="진행" value={summary.counts.running} tone="blue" />
        <Metric label="검토" value={summary.counts.reviewNeeded} tone="amber" />
        <Metric label="막힘" value={summary.counts.blocked} tone="red" />
        <Metric label="완료" value={summary.counts.done} tone="emerald" />
      </div>
      {summary.telegramUrl ? (
        <a className="mt-5 block rounded-2xl bg-white px-4 py-3 text-center font-semibold text-slate-950" href={summary.telegramUrl}>
          Telegram에서 헤르 열기
        </a>
      ) : null}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "blue" | "amber" | "red" | "emerald" }) {
  const tones = {
    blue: "bg-blue-400/15 text-blue-100",
    amber: "bg-amber-400/15 text-amber-100",
    red: "bg-red-400/15 text-red-100",
    emerald: "bg-emerald-400/15 text-emerald-100",
  };
  return (
    <div className={`rounded-2xl p-4 ${tones[tone]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm opacity-80">{label}</div>
    </div>
  );
}

function IssueList({ issues }: { issues: MobileIssueRow[] }) {
  const priorityIssues = useMemo(
    () => issues.filter((issue) => issue.status !== "done").slice(0, 6),
    [issues],
  );

  return (
    <section className="rounded-[1.75rem] bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-950 dark:text-white">우선 확인 이슈</h2>
        <span className="text-sm text-slate-500">{priorityIssues.length}개</span>
      </div>
      <div className="mt-4 space-y-3">
        {priorityIssues.length === 0 ? (
          <p className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200">
            현재 진행/검토/막힘 이슈가 없습니다.
          </p>
        ) : (
          priorityIssues.map((issue) => <IssueCard key={issue.id} issue={issue} />)
        )}
      </div>
    </section>
  );
}

function IssueCard({ issue }: { issue: MobileIssueRow }) {
  return (
    <article className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-center justify-between gap-3">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClasses[issue.status]}`}>
          {statusLabels[issue.status]}
        </span>
        <span className="text-xs text-slate-500">{formatRelative(issue.updatedAt)}</span>
      </div>
      <h3 className="mt-3 text-base font-semibold leading-6 text-slate-950 dark:text-white">{issue.title}</h3>
      <p className="mt-2 text-sm text-slate-500">
        담당: {issue.assigneeName ?? "미지정"} · 우선순위: {issue.priority ?? "기본"}
      </p>
      {issue.risk ? <p className="mt-2 text-sm font-medium text-red-600 dark:text-red-300">리스크: {issue.risk}</p> : null}
    </article>
  );
}

function AgentStrip({ agents }: { agents: MobileAgentRow[] }) {
  return (
    <section className="rounded-[1.75rem] bg-white p-5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <h2 className="text-xl font-bold text-slate-950 dark:text-white">에이전트</h2>
      <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
        {agents.length === 0 ? (
          <p className="text-sm text-slate-500">표시할 에이전트가 없습니다.</p>
        ) : (
          agents.map((agent) => (
            <article key={agent.id} className="min-w-48 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${agentStatusClasses[agent.status]}`}>
                {agentStatusLabels[agent.status]}
              </span>
              <h3 className="mt-3 font-semibold text-slate-950 dark:text-white">{agent.name}</h3>
              <p className="text-sm text-slate-500">{agent.role}</p>
              <p className="mt-3 text-xs text-slate-500">최근: {formatRelative(agent.lastActivityAt)}</p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function ChatPanel({ messages }: { messages: MobileChatMessage[] }) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const send = useMutation({
    mutationFn: (messageText: string) => postMobileChatMessage(messageText),
    onSuccess: () => {
      setText("");
      queryClient.invalidateQueries({ queryKey: ["mobile", "chat"] });
    },
  });

  useEffect(() => {
    const chatWindow = scrollRef.current;
    if (!chatWindow) return;
    if (typeof chatWindow.scrollTo === "function") {
      chatWindow.scrollTo({ top: chatWindow.scrollHeight, behavior: "smooth" });
      return;
    }
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }, [messages.length]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed) send.mutate(trimmed);
  };

  const quickPrompts = ["페퍼 상태 알려줘", "막힌 작업 요약해줘", "완료된 것만 정리해줘"];

  return (
    <section className="overflow-hidden rounded-[2rem] bg-white shadow-xl shadow-slate-900/10 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="bg-gradient-to-r from-slate-950 via-blue-950 to-slate-900 px-5 py-4 text-white">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-400 text-lg font-black text-slate-950 shadow-lg shadow-blue-500/30">
            H
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold">헤르 채팅</h2>
              <span className="rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs font-semibold text-emerald-200">online</span>
            </div>
            <p className="mt-1 text-sm leading-5 text-slate-300">텔레그램처럼 가볍게 요청하고 답변을 확인합니다.</p>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        aria-label="헤르와의 대화 내용"
        className="max-h-[28rem] min-h-80 space-y-4 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.10),_transparent_35%),linear-gradient(180deg,_#f8fafc,_#eef2ff)] px-4 py-5 dark:bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0f172a)]"
      >
        {messages.length === 0 ? (
          <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-white/80 p-5 text-center text-sm leading-6 text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300">
            <p className="text-base font-semibold text-slate-900 dark:text-white">아직 대화가 없습니다.</p>
            <p className="mt-2">페퍼 상황 확인, 작업 지시, 완료 보고 요청을 헤르에게 바로 남기세요.</p>
          </div>
        ) : (
          messages.map((message) => {
            const isUser = message.role === "user";
            return (
              <article key={message.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[82%] ${isUser ? "items-end" : "items-start"} flex flex-col gap-1.5`}>
                  <span className="px-1 text-xs font-semibold text-slate-500 dark:text-slate-400">{isUser ? "나" : "헤르"}</span>
                  <div
                    className={`rounded-[1.35rem] px-4 py-3 text-[15px] leading-6 shadow-sm ${
                      isUser
                        ? "rounded-br-md bg-blue-500 text-white shadow-blue-500/20"
                        : "rounded-bl-md bg-white text-slate-800 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{message.text}</p>
                    <div className={`mt-2 flex items-center justify-end gap-1.5 text-[11px] ${isUser ? "text-blue-100" : "text-slate-400"}`}>
                      <span>{formatRelative(message.createdAt)}</span>
                      {isUser ? <span aria-hidden="true">✓</span> : null}
                    </div>
                    {message.error ? <p className="mt-2 text-xs font-medium text-red-300">{message.error}</p> : null}
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>

      <div className="border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {quickPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => setText(prompt)}
              className="shrink-0 rounded-full bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
            >
              {prompt}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex items-end gap-2 rounded-[1.6rem] bg-slate-100 p-2 ring-1 ring-slate-200 dark:bg-slate-950 dark:ring-slate-800">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="헤르에게 메시지 보내기"
            rows={1}
            className="max-h-32 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-3 py-3 text-base leading-6 text-slate-950 outline-none placeholder:text-slate-400 dark:text-white"
          />
          <button
            type="submit"
            disabled={!text.trim() || send.isPending}
            aria-label="헤르에게 메시지 전송"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-500 text-lg font-black text-white shadow-lg shadow-blue-500/25 transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ↑
          </button>
        </form>
        {send.isError ? <p className="mt-2 px-2 text-sm text-red-600">{mobileErrorMessage(send.error)}</p> : null}
      </div>
    </section>
  );
}

function MobileDashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const queryClient = useQueryClient();
  const summary = useQuery({ queryKey: ["mobile", "summary"], queryFn: () => fetchMobileSummary() });
  const issues = useQuery({ queryKey: ["mobile", "issues"], queryFn: () => fetchMobileIssues() });
  const agents = useQuery({ queryKey: ["mobile", "agents"], queryFn: () => fetchMobileAgents() });
  const chat = useQuery({ queryKey: ["mobile", "chat"], queryFn: () => fetchMobileChatMessages() });
  const logout = useMutation({
    mutationFn: () => logoutMobile(),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["mobile"] });
      onLoggedOut();
    },
  });

  const unauthorized = [summary.error, issues.error, agents.error, chat.error].some(
    (error) => error instanceof MobileApiError && error.status === 401,
  );

  if (unauthorized) return <LoginPanel onLoggedIn={() => window.location.reload()} />;

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-5 text-slate-900 dark:bg-slate-950">
      <div className="mx-auto max-w-md space-y-4 pb-24">
        <header className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm font-semibold text-blue-600 dark:text-blue-300">Her × Pepper</p>
            <h1 className="text-2xl font-bold text-slate-950 dark:text-white">모바일 상황판</h1>
          </div>
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800"
          >
            로그아웃
          </button>
        </header>

        {summary.isLoading ? (
          <div className="rounded-[1.75rem] bg-white p-5 text-sm text-slate-500 dark:bg-slate-900">불러오는 중...</div>
        ) : summary.isError ? (
          <div className="rounded-[1.75rem] bg-red-50 p-5 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-200">
            {mobileErrorMessage(summary.error)}
          </div>
        ) : summary.data ? (
          <SummaryCard summary={summary.data} />
        ) : (
          <div className="rounded-[1.75rem] bg-white p-5 text-sm text-slate-500 dark:bg-slate-900">요약 데이터가 없습니다.</div>
        )}

        <ChatPanel messages={chat.data?.messages ?? []} />
        <IssueList issues={issues.data?.issues ?? []} />
        <AgentStrip agents={agents.data?.agents ?? []} />
      </div>
    </main>
  );
}

export function MobileAppPage() {
  const [loggedIn, setLoggedIn] = useState(false);
  return loggedIn ? (
    <MobileDashboard onLoggedOut={() => setLoggedIn(false)} />
  ) : (
    <LoginPanel onLoggedIn={() => setLoggedIn(true)} />
  );
}
