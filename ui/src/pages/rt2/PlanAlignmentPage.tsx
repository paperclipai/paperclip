import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  ExternalLink,
  MinusCircle,
} from "lucide-react";
import { Link } from "@/lib/router";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";

type AlignmentStatus = "shipped" | "partial" | "missing";
type ValidationStatus = "validated" | "tech_debt" | "deferred";

type AlignmentItem = {
  id: string;
  area: string;
  status: AlignmentStatus;
  validationStatus: ValidationStatus;
  current: string;
  gap: string;
  phase: string;
};

const STATUS_LABELS: Record<AlignmentStatus, string> = {
  shipped: "Shipped",
  partial: "Partial",
  missing: "Missing",
};

const VALIDATION_LABELS: Record<ValidationStatus, string> = {
  validated: "Validated",
  tech_debt: "Tech debt",
  deferred: "Deferred",
};

const STATUS_STYLES: Record<AlignmentStatus, string> = {
  shipped: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-100",
  partial: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100",
  missing: "border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-100",
};

const VALIDATION_STYLES: Record<ValidationStatus, string> = {
  validated: "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900/70 dark:bg-sky-950/30 dark:text-sky-100",
  tech_debt: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100",
  deferred: "border-border bg-background text-muted-foreground",
};

const ALIGNMENT_ITEMS: AlignmentItem[] = [
  {
    id: "rt2-shell",
    area: "RT2 shell and product identity",
    status: "shipped",
    validationStatus: "validated",
    current: "Company-prefixed RT2 shell, One-Liner, knowledge, marketplace, P&L, governance, and control-plane routes exist. Phase 15 strict validation now records product-facing RT2 identity evidence.",
    gap: "Internal package/API/route compatibility names remain engine-layer only.",
    phase: "Phase 15",
  },
  {
    id: "one-liner",
    area: "One-Liner capture",
    status: "shipped",
    validationStatus: "deferred",
    current: "Structured capture, floating widget, global shortcut, voice draft, messenger inbound draft, and immediate reward evidence are present.",
    gap: "Native/mobile inbound queue promotion is Phase 23 scope.",
    phase: "Phase 16 / 23",
  },
  {
    id: "daily-report",
    area: "Daily report cockpit",
    status: "shipped",
    validationStatus: "validated",
    current: "Three-panel daily cockpit shows report/task activity, deliverables, quality state, gold/XP impact, Jarvis detail, and Trello-style drag/drop lane move. Phase 14 strict validation is present.",
    gap: "Checklist, due date, attachment preview, and advanced board filtering remain Phase 23 scope.",
    phase: "Phase 14",
  },
  {
    id: "okr-kpi",
    area: "Mission to To-Do traceability",
    status: "shipped",
    validationStatus: "validated",
    current: "Daily cockpit exposes available Mission, Objective, Key Result, Project, Task, and To-Do trace rows and gap flags.",
    gap: "Enterprise rollout can tighten template defaults for missing hierarchy data.",
    phase: "Phase 10",
  },
  {
    id: "task-mesh",
    area: "Task Mesh",
    status: "shipped",
    validationStatus: "validated",
    current: "Task Mesh exposes hierarchy, dependency, timeline, collaborator, deliverable, knowledge, and economy views with node evidence.",
    gap: "Future work can add richer graph interaction and layout persistence.",
    phase: "Phase 11",
  },
  {
    id: "knowledge",
    area: "wikiLLM and Graphify knowledge loop",
    status: "shipped",
    validationStatus: "validated",
    current: "Knowledge workspace includes wiki pages, real graph panel, graph reports, God Nodes, warnings, pending events, vault export, import preview, and Phase 19 route fallback validation.",
    gap: "Actual Obsidian local writer and bidirectional conflict resolution are Phase 21 scope.",
    phase: "Phase 17 / 19",
  },
  {
    id: "jarvis",
    area: "Jarvis modes and change management",
    status: "shipped",
    validationStatus: "validated",
    current: "Jarvis manager review, policy threshold routing, reverse-designed task proposal, and governed runtime skill capability are present.",
    gap: "Future work can connect reverse-designed proposals to task creation approvals.",
    phase: "Phase 12",
  },
  {
    id: "economy",
    area: "Amoeba economy and marketplace",
    status: "shipped",
    validationStatus: "validated",
    current: "P&L, coin ledger, marketplace evidence, collaboration rewards, quality-backed pricing, settlement evidence, and Phase 19 route fallback validation are materially present.",
    gap: "Pricing negotiation, settlement approval, and anti-gaming depth are Phase 22 scope.",
    phase: "Phase 18 / 19",
  },
  {
    id: "enterprise",
    area: "Enterprise rollout",
    status: "shipped",
    validationStatus: "validated",
    current: "RT2-labeled rollout surface configures SSO, company template, access mode, and policy defaults with saved-value hydrate and Phase 19 route fallback validation.",
    gap: "Actual SSO metadata validation and SCIM preview are Phase 20 scope.",
    phase: "Phase 18 / 19",
  },
  {
    id: "mobile-native",
    area: "Native mobile distribution",
    status: "missing",
    validationStatus: "deferred",
    current: "Responsive web surfaces exist.",
    gap: "Store-distributed native app remains future scope; inbound native capture queue is Phase 23.",
    phase: "Future",
  },
];

function StatusIcon({ status }: { status: AlignmentStatus }) {
  if (status === "shipped") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "partial") return <CircleDashed className="h-4 w-4" />;
  return <MinusCircle className="h-4 w-4" />;
}

export function PlanAlignmentPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [statusFilter, setStatusFilter] = useState<"all" | AlignmentStatus>("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Plan Alignment" }]);
  }, [setBreadcrumbs]);

  const counts = useMemo(
    () => ({
      shipped: ALIGNMENT_ITEMS.filter((item) => item.status === "shipped").length,
      partial: ALIGNMENT_ITEMS.filter((item) => item.status === "partial").length,
      missing: ALIGNMENT_ITEMS.filter((item) => item.status === "missing").length,
      validated: ALIGNMENT_ITEMS.filter((item) => item.validationStatus === "validated").length,
      techDebt: ALIGNMENT_ITEMS.filter((item) => item.validationStatus === "tech_debt").length,
      deferred: ALIGNMENT_ITEMS.filter((item) => item.validationStatus === "deferred").length,
    }),
    [],
  );

  const filteredItems = useMemo(
    () => statusFilter === "all" ? ALIGNMENT_ITEMS : ALIGNMENT_ITEMS.filter((item) => item.status === statusFilter),
    [statusFilter],
  );

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card px-6 py-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
              <ClipboardList className="h-4 w-4" />
              Development Plan Alignment
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold">RealTycoon2 development-plan reflection map</h1>
              <p className="text-sm leading-6 text-muted-foreground">
                Uploaded development plan 기준으로 현재 앱이 반영한 영역, 부분 반영 영역, 아직 빠진 영역을 한 화면에 고정합니다.
                Phase 19 이후에는 validation artifact, route fallback, deferred scope도 함께 추적합니다.
              </p>
            </div>
          </div>
          <div className="grid min-w-[18rem] grid-cols-3 gap-2">
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-lg font-semibold">{counts.shipped}</div>
              <div className="text-xs text-muted-foreground">Shipped</div>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-lg font-semibold">{counts.partial}</div>
              <div className="text-xs text-muted-foreground">Partial</div>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-lg font-semibold">{counts.missing}</div>
              <div className="text-xs text-muted-foreground">Missing</div>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-lg font-semibold">{counts.validated}</div>
              <div className="text-xs text-muted-foreground">Validated</div>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-lg font-semibold">{counts.techDebt}</div>
              <div className="text-xs text-muted-foreground">Tech debt</div>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-lg font-semibold">{counts.deferred}</div>
              <div className="text-xs text-muted-foreground">Deferred</div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Adoption baseline</h2>
            <p className="text-sm text-muted-foreground">
              Status는 `.planning/DEVPLAN-ALIGNMENT.md`와 Phase 19 validation artifact를 앱에서 볼 수 있게 정리한 것입니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["all", "shipped", "partial", "missing"] as const).map((status) => (
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
                {status === "all" ? "All" : STATUS_LABELS[status]}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-3">
        {filteredItems.map((item) => (
          <article key={item.id} className="rounded-lg border border-border bg-card px-5 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${STATUS_STYLES[item.status]}`}>
                    <StatusIcon status={item.status} />
                    {STATUS_LABELS[item.status]}
                  </span>
                  <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${VALIDATION_STYLES[item.validationStatus]}`}>
                    {VALIDATION_LABELS[item.validationStatus]}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">{item.phase}</span>
                </div>
                <div>
                  <h3 className="text-base font-semibold">{item.area}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.current}</p>
                </div>
              </div>
              <div className="rounded-lg border border-border bg-background px-4 py-3 lg:w-[24rem]">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <AlertTriangle className="h-4 w-4" />
                  Gap / next action
                </div>
                <p className="text-sm leading-6">{item.gap}</p>
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold">Next implementation owner</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Phase 19에서 v2.2 validation debt는 닫혔고, 남은 운영 깊이는 Phase 20-23으로 분리됩니다.
            </p>
          </div>
          <Link
            to="/enterprise-rollout"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent/40"
          >
            Enterprise Rollout
            <ExternalLink className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
