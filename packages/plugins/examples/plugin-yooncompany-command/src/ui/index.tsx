import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  useHostContext,
  useHostNavigation,
  usePluginAction,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

const ACTION_KEYS = {
  createGuidedIssue: "create-guided-issue",
} as const;

type GuidedIssueKind = "ask_codex" | "ask_hermes" | "new_task";

type DashboardResponse = {
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  runActivity: Array<{
    date: string;
    succeeded: number;
    failed: number;
    other: number;
    total: number;
  }>;
};

type IssueSummary = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
};

type ApprovalSummary = {
  id: string;
  status: string;
  payload?: {
    proposalId?: unknown;
    title?: unknown;
  };
};

type CommandData = {
  dashboard: DashboardResponse;
  issues: IssueSummary[];
  approvals: ApprovalSummary[];
};

type CreatedIssueResult = {
  id: string;
  identifier?: string | null;
  route: string;
};

type GuideItem = {
  title: string;
  body: string;
};

const panelStyle: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--card-foreground)",
  padding: "14px",
  display: "grid",
  gap: "12px",
  minWidth: 0,
};

const compactPanelStyle: CSSProperties = {
  ...panelStyle,
  padding: "12px",
  fontSize: "12px",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
};

const metricStyle: CSSProperties = {
  border: "1px solid var(--border)",
  padding: "10px",
  minWidth: 0,
  display: "grid",
  gap: "4px",
  textDecoration: "none",
  color: "inherit",
};

const labelStyle: CSSProperties = {
  color: "var(--muted-foreground)",
  fontSize: "12px",
  lineHeight: 1.25,
  overflowWrap: "anywhere",
};

const valueStyle: CSSProperties = {
  fontSize: "22px",
  lineHeight: 1,
  fontWeight: 700,
};

const buttonGridStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))",
};

const buttonStyle: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--background)",
  color: "var(--foreground)",
  cursor: "pointer",
  minHeight: "36px",
  padding: "8px",
  textAlign: "left",
  font: "inherit",
  lineHeight: 1.2,
  overflowWrap: "anywhere",
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: "var(--muted-foreground)",
};

const stackStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
};

const guideItemStyle: CSSProperties = {
  border: "1px solid var(--border)",
  padding: "8px",
  display: "grid",
  gap: "3px",
};

const guideTitleStyle: CSSProperties = {
  color: "var(--foreground)",
  fontWeight: 600,
  lineHeight: 1.2,
};

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function latestFailedRuns(dashboard: DashboardResponse): number {
  const latest = dashboard.runActivity.at(-1);
  return latest?.failed ?? 0;
}

function looksLikeEvolutionProposal(issue: IssueSummary): boolean {
  const haystack = `${issue.title} ${issue.description ?? ""}`.toLowerCase();
  return haystack.includes("evolution") || haystack.includes("proposal") || haystack.includes("rule");
}

function pendingProposalCount(issues: IssueSummary[], approvals: ApprovalSummary[]): number {
  const issueCount = issues.filter((issue) => issue.status !== "done" && looksLikeEvolutionProposal(issue)).length;
  const approvalCount = approvals.filter((approval) => {
    if (approval.status !== "pending") return false;
    const title = typeof approval.payload?.title === "string" ? approval.payload.title : "";
    const proposalId = typeof approval.payload?.proposalId === "string" ? approval.payload.proposalId : "";
    return `${title} ${proposalId}`.toLowerCase().includes("proposal");
  }).length;
  return issueCount + approvalCount;
}

function useCommandData(companyId: string | null | undefined) {
  const [data, setData] = useState<CommandData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [dashboard, issues, approvals] = await Promise.all([
          fetchJson<DashboardResponse>(`/api/companies/${companyId}/dashboard`),
          fetchJson<IssueSummary[]>(
            `/api/companies/${companyId}/issues?status=todo,in_progress,in_review,blocked&limit=50`,
          ),
          fetchJson<ApprovalSummary[]>(`/api/companies/${companyId}/approvals`),
        ]);
        if (!cancelled) setData({ dashboard, issues, approvals });
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [companyId]);

  return { data, error, loading };
}

function MetricLink({
  label,
  value,
  to,
}: {
  label: string;
  value: number | string;
  to: string;
}) {
  const hostNavigation = useHostNavigation();
  return (
    <a {...hostNavigation.linkProps(to)} style={metricStyle}>
      <span key="value" style={valueStyle}>{value}</span>
      <span key="label" style={labelStyle}>{label}</span>
    </a>
  );
}

function CommandMetrics({ data }: { data: CommandData }) {
  const failedRuns = latestFailedRuns(data.dashboard);
  const proposals = pendingProposalCount(data.issues, data.approvals);
  const blocked = data.dashboard.tasks.blocked;
  const pendingApprovals = data.approvals.filter((approval) => approval.status === "pending").length;
  const spend = formatCents(data.dashboard.costs.monthSpendCents);

  return (
    <div style={gridStyle}>
      <MetricLink key="approvals" label="승인 대기" value={pendingApprovals || data.dashboard.pendingApprovals} to="/inbox" />
      <MetricLink key="blocked" label="막힌 작업" value={blocked} to="/issues" />
      <MetricLink key="failed" label="오늘 실패" value={failedRuns} to="/activity" />
      <MetricLink key="evolution" label="개선 후보" value={proposals} to="/issues" />
      <MetricLink key="spend" label="월 비용" value={spend} to="/costs" />
    </div>
  );
}

function nextActionText(data: CommandData): string {
  const pendingApprovals = data.approvals.filter((approval) => approval.status === "pending").length;
  if (pendingApprovals > 0) return "승인 대기부터 확인";
  if (data.dashboard.tasks.blocked > 0) return "막힌 작업 복구";
  if (latestFailedRuns(data.dashboard) > 0) return "실패 실행 확인";
  if (data.dashboard.tasks.open > 0) return "열린 작업 진행";
  return "새 작업 생성";
}

export function YoonCompanyCommandWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const { data, error, loading } = useCommandData(companyId);

  return (
    <section aria-label="YoonCompany 운영 현황" style={panelStyle}>
      <div key="header" style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
        <strong key="title">YoonCompany 운영</strong>
        <span key="status" style={labelStyle}>{data ? nextActionText(data) : loading ? "확인 중" : "대기"}</span>
      </div>
      {error ? <div key="error" style={labelStyle}>상태 로드 실패: {error}</div> : null}
      {data ? <CommandMetrics key="metrics" data={data} /> : <div key="loading" style={labelStyle}>Paperclip 상태를 불러오는 중입니다.</div>}
    </section>
  );
}

function quickActionLabel(kind: GuidedIssueKind): string {
  if (kind === "ask_codex") return "Codex 질문 초안";
  if (kind === "ask_hermes") return "Hermes 조사 초안";
  return "새 작업 초안";
}

export function YoonCompanyQuickActionsPanel() {
  const context = useHostContext();
  const hostNavigation = useHostNavigation();
  const createGuidedIssue = usePluginAction(ACTION_KEYS.createGuidedIssue);
  const [busyKind, setBusyKind] = useState<GuidedIssueKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const companyId = context.companyId;
  const disabled = !companyId || busyKind !== null;

  const guideItems = useMemo<GuideItem[]>(
    () => [
      {
        title: "1. 승인 대기",
        body: "먼저 검토해야 할 실행과 변경 요청을 확인합니다.",
      },
      {
        title: "2. 막힌 작업",
        body: "작업 상세에서 원인, 담당 직원, 최근 실행 로그를 확인합니다.",
      },
      {
        title: "3. 화면/기능 질문",
        body: "오른쪽 전역 질문 패널이나 Codex 질문 초안으로 보류 작업을 만들고, 실행 전 6002 검증 기준을 확인합니다.",
      },
      {
        title: "4. 외부 조사",
        body: "서비스 비교, 가이드, 공개 자료 정리는 Hermes 조사로 만들고 파일 수정 없이 보고만 받습니다.",
      },
      {
        title: "5. 실행 확인",
        body: "보드에서 상태를 변경해 직원 실행을 시작한 뒤, 대시보드/직원 상세에서 결과, 로그, 비용, 세션을 확인합니다.",
      },
    ],
    [],
  );

  async function createIssue(kind: GuidedIssueKind) {
    if (!companyId) return;
    setBusyKind(kind);
    setError(null);
    try {
      const result = await createGuidedIssue({ companyId, kind }) as CreatedIssueResult;
      hostNavigation.navigate(result.route);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <section aria-label="YoonCompany 빠른 실행" style={compactPanelStyle}>
      <strong key="title">작업 초안</strong>
      <div key="actions" style={buttonGridStyle}>
        {(["ask_codex", "ask_hermes", "new_task"] as GuidedIssueKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={disabled}
            style={{ ...buttonStyle, opacity: disabled ? 0.65 : 1 }}
            onClick={() => {
              void createIssue(kind);
            }}
          >
            {busyKind === kind ? "생성 중" : quickActionLabel(kind)}
          </button>
        ))}
        <button
          key="guide-toggle"
          type="button"
          style={secondaryButtonStyle}
          aria-expanded={showGuide}
          aria-controls="yooncompany-quick-actions-guide"
          onClick={() => setShowGuide((value) => !value)}
        >
          {showGuide ? "사용법 접기" : "사용법 보기"}
        </button>
      </div>
      {error ? <div key="error" style={labelStyle}>생성 실패: {error}</div> : null}
      {showGuide ? (
        <div key="guide" id="yooncompany-quick-actions-guide" style={stackStyle}>
          {guideItems.map((item) => (
            <div key={item.title} style={guideItemStyle}>
              <span style={guideTitleStyle}>{item.title}</span>
              <span style={labelStyle}>{item.body}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
