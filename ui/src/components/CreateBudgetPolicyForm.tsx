import { useState } from "react";
import type { Agent, Project, BudgetPolicyUpsertInput } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus } from "lucide-react";

type ScopeType = "company" | "agent" | "project";
type WindowKind = "calendar_month_utc" | "lifetime";

function parseDollarInput(value: string): number | null {
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export function CreateBudgetPolicyForm({
  companyId,
  agents,
  projects,
  onSubmit,
  isSubmitting,
}: {
  companyId: string;
  agents: Agent[];
  projects: Project[];
  onSubmit: (input: BudgetPolicyUpsertInput) => void;
  isSubmitting?: boolean;
}) {
  const [scopeType, setScopeType] = useState<ScopeType>("company");
  const [scopeId, setScopeId] = useState(companyId);
  const [windowKind, setWindowKind] = useState<WindowKind>("calendar_month_utc");
  const [amountStr, setAmountStr] = useState("");
  const [warnPercent, setWarnPercent] = useState("80");
  const [hardStopEnabled, setHardStopEnabled] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState(true);

  const parsedAmount = parseDollarInput(amountStr);
  const parsedWarnPercent = Number(warnPercent);
  const validWarnPercent = Number.isFinite(parsedWarnPercent) && parsedWarnPercent >= 1 && parsedWarnPercent <= 100;

  const canSubmit =
    parsedAmount !== null &&
    parsedAmount > 0 &&
    validWarnPercent &&
    scopeId.length > 0 &&
    !isSubmitting;

  function handleScopeTypeChange(next: ScopeType) {
    setScopeType(next);
    if (next === "company") {
      setScopeId(companyId);
      setWindowKind("calendar_month_utc");
    } else if (next === "agent") {
      setScopeId(agents[0]?.id ?? "");
      setWindowKind("calendar_month_utc");
    } else {
      setScopeId(projects[0]?.id ?? "");
      setWindowKind("lifetime");
    }
  }

  function handleSubmit() {
    if (!canSubmit || parsedAmount === null) return;
    onSubmit({
      scopeType,
      scopeId,
      metric: "billed_cents",
      windowKind,
      amount: parsedAmount,
      warnPercent: parsedWarnPercent,
      hardStopEnabled,
      notifyEnabled,
    });
    setAmountStr("");
  }

  const selectClass =
    "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

  return (
    <Card className="border-border/70 bg-card/80">
      <CardHeader className="px-5 pt-5 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Plus className="h-4 w-4" />
          새 예산 정책 생성
        </CardTitle>
        <CardDescription>
          에이전트, 프로젝트 또는 회사 전체에 대한 지출 한도를 설정합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Scope type */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              대상 유형
            </label>
            <select
              className={selectClass + " mt-2"}
              value={scopeType}
              onChange={(e) => handleScopeTypeChange(e.target.value as ScopeType)}
            >
              <option value="company">회사</option>
              <option value="agent">에이전트</option>
              <option value="project">프로젝트</option>
            </select>
          </div>

          {/* Scope target */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              대상
            </label>
            {scopeType === "company" ? (
              <Input className="mt-2" value="(회사 전체)" disabled />
            ) : scopeType === "agent" ? (
              <select
                className={selectClass + " mt-2"}
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
              >
                {agents.length === 0 && <option value="">에이전트 없음</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                className={selectClass + " mt-2"}
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
              >
                {projects.length === 0 && <option value="">프로젝트 없음</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Window kind */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              기간
            </label>
            <select
              className={selectClass + " mt-2"}
              value={windowKind}
              onChange={(e) => setWindowKind(e.target.value as WindowKind)}
            >
              <option value="calendar_month_utc">월별 (UTC)</option>
              <option value="lifetime">전체 기간</option>
            </select>
          </div>

          {/* Amount */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              예산 (USD)
            </label>
            <Input
              className="mt-2"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
          </div>

          {/* Warn percent */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              경고 임계값 (%)
            </label>
            <Input
              className="mt-2"
              value={warnPercent}
              onChange={(e) => setWarnPercent(e.target.value)}
              inputMode="numeric"
              placeholder="80"
            />
          </div>

          {/* Toggles */}
          <div className="space-y-3 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hardStopEnabled}
                onChange={(e) => setHardStopEnabled(e.target.checked)}
                className="rounded border-border"
              />
              하드 스톱 (한도 도달 시 실행 일시정지)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={notifyEnabled}
                onChange={(e) => setNotifyEnabled(e.target.checked)}
                className="rounded border-border"
              />
              소프트 알림 (경고 임계값 도달 시 알림)
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? "생성 중..." : "정책 생성"}
          </Button>
          {parsedAmount === null && amountStr.length > 0 && (
            <span className="text-xs text-destructive">유효한 금액을 입력하세요.</span>
          )}
          {!validWarnPercent && (
            <span className="text-xs text-destructive">1~100 사이의 퍼센트를 입력하세요.</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
