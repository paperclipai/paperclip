import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, ClipboardList, MinusCircle } from "lucide-react";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";

type AlignmentStatus = "complete" | "partial" | "tech_debt" | "missing";

type AlignmentItem = {
  id: string;
  area: string;
  status: AlignmentStatus;
  weight: number;
  ownerPhase: string;
  requirements: string[];
  evidence: string;
  current: string;
  gap: string;
};

const STATUS_LABELS: Record<AlignmentStatus, string> = {
  complete: "완료",
  partial: "부분 반영",
  tech_debt: "기술 부채",
  missing: "미구현",
};

const STATUS_STYLES: Record<AlignmentStatus, string> = {
  complete:
    "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-100",
  partial:
    "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100",
  tech_debt:
    "border-orange-200 bg-orange-50 text-orange-950 dark:border-orange-900/70 dark:bg-orange-950/30 dark:text-orange-100",
  missing: "border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-100",
};

const ALIGNMENT_ITEMS: AlignmentItem[] = [
  {
    id: "alignment-truth",
    area: "개발기획서 근거 매트릭스",
    status: "complete",
    weight: 10,
    ownerPhase: "65",
    requirements: ["ALIGN-01", "ALIGN-02"],
    evidence: "gate, UI, context",
    current: "Phase 65가 개발기획서 축별 상태와 근거 파일을 한 화면과 gate 산출물로 고정했습니다.",
    gap: "이후 phase가 새 근거를 추가할 때 같은 기준으로 score를 갱신해야 합니다.",
  },
  {
    id: "identity-boundary",
    area: "RealTycoon2 제품 정체성 경계",
    status: "complete",
    weight: 10,
    ownerPhase: "65",
    requirements: ["IDENTITY-01", "IDENTITY-03"],
    evidence: "compatibility docs",
    current: "RealTycoon2는 제품 정체성이고 legacy control-plane 명칭은 호환성 계층으로 분리했습니다.",
    gap: "패키지와 환경 변수 이름은 호환성 문맥으로 유지됩니다.",
  },
  {
    id: "identity-regression",
    area: "제품 표면 정체성 회귀 스캔",
    status: "complete",
    weight: 10,
    ownerPhase: "65",
    requirements: ["IDENTITY-02"],
    evidence: "identity gate",
    current: "UI, docs, server-facing copy가 RealTycoon2-first Korean identity 기준으로 검사됩니다.",
    gap: "새 표면이 생기면 identity gate 대상에 추가해야 합니다.",
  },
  {
    id: "daily-cockpit",
    area: "일일 업무 cockpit",
    status: "partial",
    weight: 12,
    ownerPhase: "66",
    requirements: ["DAILY-01", "DAILY-02", "DAILY-03"],
    evidence: "DailyWorkPage, Rt2DailyBoard",
    current: "일일 업무 기록과 보드 근거는 있으나 v3.1 3-panel cockpit 수렴은 아직 완료되지 않았습니다.",
    gap: "Phase 66에서 Mission부터 To-Do까지의 업무 흐름과 cockpit proof를 닫습니다.",
  },
  {
    id: "mission-okr-rollup",
    area: "Mission to To-Do 계층",
    status: "partial",
    weight: 8,
    ownerPhase: "66",
    requirements: ["DAILY-03"],
    evidence: "daily report types, service",
    current: "계층 데이터는 여러 경로에 존재하지만 API와 UI가 하나의 rollup 근거로 닫히지 않았습니다.",
    gap: "Phase 66에서 누락 flag와 rollup evidence를 같은 화면에 연결합니다.",
  },
  {
    id: "runtime-execution",
    area: "참조 런타임 실행 parity",
    status: "tech_debt",
    weight: 12,
    ownerPhase: "67",
    requirements: ["RUNTIME-01", "RUNTIME-02", "RUNTIME-03"],
    evidence: "task execution service, reference audit",
    current: "실행 서비스는 있으나 heartbeat cleanup, cancellation, progress stream parity는 완료 근거가 부족합니다.",
    gap: "Phase 67에서 runtime-aware claim과 progress/cancel 경계를 검증합니다.",
  },
  {
    id: "wikillm-memory",
    area: "wikiLLM 누적 메모리",
    status: "partial",
    weight: 10,
    ownerPhase: "68",
    requirements: ["WIKI-01", "WIKI-02", "WIKI-03"],
    evidence: "knowledge projector, wiki schema",
    current: "지식 projection과 schema 근거는 있으나 living memory export loop는 부분 구현 상태입니다.",
    gap: "Phase 68에서 index, log, topic page export와 Jarvis 검토 루프를 연결합니다.",
  },
  {
    id: "graphify-v3-sidecar",
    area: "Graphify v3 지식 그래프 sidecar",
    status: "tech_debt",
    weight: 12,
    ownerPhase: "69",
    requirements: ["GRAPH-01", "GRAPH-02", "GRAPH-03", "GRAPH-04"],
    evidence: "graph projection schema, reference audit",
    current: "projection schema는 있으나 corpus ingest, provenance, clustering, path query parity는 debt로 남아 있습니다.",
    gap: "Phase 69에서 실제 corpus graph sidecar 근거를 닫습니다.",
  },
  {
    id: "economy-loop",
    area: "경제, 마켓플레이스, P&L, CareerMate loop",
    status: "partial",
    weight: 12,
    ownerPhase: "70",
    requirements: ["ECON-01", "ECON-02", "ECON-03"],
    evidence: "P&L routes, marketplace routes, gamification panel",
    current: "ledger, marketplace, quality pricing 근거는 있으나 주 navigation loop와 성장 흐름은 연결 debt가 있습니다.",
    gap: "Phase 70에서 품질 근거, 정산, CareerMate progression을 하나의 운영 loop로 묶습니다.",
  },
  {
    id: "v31-acceptance-gate",
    area: "v3.1 acceptance score delta",
    status: "missing",
    weight: 4,
    ownerPhase: "71",
    requirements: ["GATE-01", "GATE-02"],
    evidence: "roadmap, requirements",
    current: "최종 score delta 감사는 Phase 66-70 완료 후 실행할 수 있습니다.",
    gap: "Phase 71에서 64% 기준선 대비 상승분과 남은 debt를 감사합니다.",
  },
];

function StatusIcon({ status }: { status: AlignmentStatus }) {
  if (status === "complete") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "missing") return <MinusCircle className="h-4 w-4" />;
  return <CircleDashed className="h-4 w-4" />;
}

function scoreFor(status: AlignmentStatus) {
  if (status === "complete") return 1;
  if (status === "partial") return 0.6;
  if (status === "tech_debt") return 0.35;
  return 0;
}

export function PlanAlignmentPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [statusFilter, setStatusFilter] = useState<"all" | AlignmentStatus>("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "DevPlan 정합성" }]);
  }, [setBreadcrumbs]);

  const summary = useMemo(() => {
    const counts = ALIGNMENT_ITEMS.reduce(
      (acc, item) => {
        acc[item.status] += 1;
        return acc;
      },
      { complete: 0, partial: 0, tech_debt: 0, missing: 0 } as Record<AlignmentStatus, number>,
    );
    const totalWeight = ALIGNMENT_ITEMS.reduce((sum, item) => sum + item.weight, 0);
    const earnedWeight = ALIGNMENT_ITEMS.reduce((sum, item) => sum + item.weight * scoreFor(item.status), 0);
    return {
      counts,
      score: Math.round((earnedWeight / totalWeight) * 100),
      totalWeight,
    };
  }, []);

  const filteredItems = useMemo(
    () => (statusFilter === "all" ? ALIGNMENT_ITEMS : ALIGNMENT_ITEMS.filter((item) => item.status === statusFilter)),
    [statusFilter],
  );

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card px-6 py-5">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
              <ClipboardList className="h-4 w-4" />
              DevPlan 정합성 기준선
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold">v3.1 개발기획서 반영 현황</h1>
              <p className="text-sm leading-6 text-muted-foreground">
                Phase 65 기준 정적 싱크로율은 64%입니다. 완료 주장은 근거가 있을 때만 완료로 표시하고,
                참조 엔진 parity와 핵심 제품 흐름의 남은 gap은 이후 phase owner에 연결합니다.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border bg-background px-3 py-3">
              <div className="text-xl font-semibold">{summary.score}%</div>
              <div className="text-xs text-muted-foreground">현재 점수</div>
            </div>
            <div className="rounded-md border border-border bg-background px-3 py-3">
              <div className="text-xl font-semibold">{summary.totalWeight}</div>
              <div className="text-xs text-muted-foreground">총 weight</div>
            </div>
            <div className="rounded-md border border-border bg-background px-3 py-3">
              <div className="text-xl font-semibold">{summary.counts.complete}</div>
              <div className="text-xs text-muted-foreground">완료 축</div>
            </div>
            <div className="rounded-md border border-border bg-background px-3 py-3">
              <div className="text-xl font-semibold">{summary.counts.partial}</div>
              <div className="text-xs text-muted-foreground">부분 반영</div>
            </div>
            <div className="rounded-md border border-border bg-background px-3 py-3">
              <div className="text-xl font-semibold">{summary.counts.tech_debt}</div>
              <div className="text-xs text-muted-foreground">기술 부채</div>
            </div>
            <div className="rounded-md border border-border bg-background px-3 py-3">
              <div className="text-xl font-semibold">{summary.counts.missing}</div>
              <div className="text-xs text-muted-foreground">미구현</div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">상태 필터</h2>
            <p className="text-sm text-muted-foreground">
              complete는 근거가 있는 완료만 의미하며, 나머지는 다음 phase owner가 닫아야 할 gap입니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["all", "complete", "partial", "tech_debt", "missing"] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === status
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {status === "all" ? "전체" : STATUS_LABELS[status]}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-3">
        {filteredItems.map((item) => (
          <article key={item.id} className="rounded-lg border border-border bg-card px-5 py-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_24rem] lg:items-start">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${STATUS_STYLES[item.status]}`}
                  >
                    <StatusIcon status={item.status} />
                    {STATUS_LABELS[item.status]}
                  </span>
                  <span className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
                    Phase {item.ownerPhase}
                  </span>
                  <span className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
                    weight {item.weight}
                  </span>
                </div>
                <div>
                  <h3 className="text-base font-semibold">{item.area}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.current}</p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {item.requirements.map((requirement) => (
                    <span key={requirement} className="rounded-md bg-muted px-2 py-1">
                      {requirement}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-border bg-background px-4 py-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <AlertTriangle className="h-4 w-4" />
                  다음 근거
                </div>
                <p className="text-sm leading-6">{item.gap}</p>
                <p className="mt-3 text-xs text-muted-foreground">근거: {item.evidence}</p>
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">다음 구현 owner</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Phase 66은 일일 업무 cockpit과 Mission to To-Do rollup을 먼저 닫고, Phase 67-70은 runtime,
            wikiLLM, Graphify, economy loop의 evidence debt를 순서대로 줄입니다.
          </p>
        </div>
      </section>
    </div>
  );
}
