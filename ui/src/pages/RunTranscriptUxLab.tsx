import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatDateTime } from "../lib/utils";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { RunTranscriptView, type TranscriptDensity, type TranscriptMode } from "../components/transcript/RunTranscriptView";
import { runTranscriptFixtureEntries, runTranscriptFixtureMeta } from "../fixtures/runTranscriptFixtures";
import { ExternalLink, FlaskConical, LayoutPanelLeft, MonitorCog, PanelsTopLeft, RadioTower } from "lucide-react";
import { useI18n } from "../i18n";

type SurfaceId = "detail" | "live" | "dashboard";

type SurfaceOption = {
  id: SurfaceId;
  label: string;
  eyebrow: string;
  description: string;
  icon: typeof LayoutPanelLeft;
};

function useLabCopy() {
  const { locale } = useI18n();
  const tr = (en: string, ko: string, ja: string) => locale === "ko" ? ko : locale === "ja" ? ja : en;
  const surfaceOptions: SurfaceOption[] = [
    {
      id: "detail",
      label: tr("Run Detail", "실행 상세", "実行詳細"),
      eyebrow: tr("Full transcript", "전체 트랜스크립트", "完全トランスクリプト"),
      description: tr(
        "The long-form run page with the `Nice | Raw` toggle and the most inspectable transcript view.",
        "`Nice | Raw` 토글과 가장 자세히 살필 수 있는 transcript view가 있는 장문 실행 페이지입니다.",
        "`Nice | Raw` トグルと最も詳しく確認できる transcript view を備えた長文の実行ページです。",
      ),
      icon: MonitorCog,
    },
    {
      id: "live",
      label: tr("Issue Widget", "이슈 위젯", "Issue ウィジェット"),
      eyebrow: tr("Live stream", "라이브 스트림", "ライブストリーム"),
      description: tr(
        "The issue-detail live run widget, optimized for following an active run without leaving the task page.",
        "작업 페이지를 벗어나지 않고 활성 실행을 따라갈 수 있도록 최적화된 이슈 상세 live run 위젯입니다.",
        "タスクページを離れずにアクティブな実行を追えるよう最適化された issue 詳細 live run ウィジェットです。",
      ),
      icon: RadioTower,
    },
    {
      id: "dashboard",
      label: tr("Dashboard Card", "대시보드 카드", "ダッシュボードカード"),
      eyebrow: tr("Dense card", "밀도 높은 카드", "高密度カード"),
      description: tr(
        "The active-agents dashboard card, tuned for compact scanning while keeping the same transcript language.",
        "같은 transcript 표현을 유지하면서도 빠르게 훑어볼 수 있게 조정된 활성 에이전트 대시보드 카드입니다.",
        "同じ transcript 表現を維持しつつ、素早く一覧確認できるよう調整したアクティブエージェント用ダッシュボードカードです。",
      ),
      icon: PanelsTopLeft,
    },
  ];

  return {
    locale,
    tr,
    surfaceOptions,
    uxLab: tr("UX Lab", "UX 연구실", "UX ラボ"),
    pageTitle: tr("Run Transcript Fixtures", "실행 트랜스크립트 픽스처", "実行トランスクリプト fixture"),
    pageBody: tr(
      "Built from a real Paperclip development run, then sanitized so no secrets, local paths, or environment details survive into the fixture.",
      "실제 Paperclip 개발 실행을 바탕으로 만들고, secret·로컬 경로·환경 정보가 fixture에 남지 않도록 정리했습니다.",
      "実際の Paperclip 開発実行から作成し、secret・ローカルパス・環境情報が fixture に残らないようサニタイズしています。",
    ),
    runDetail: tr("Run Detail", "실행 상세", "実行詳細"),
    transcript: tr("Transcript", "트랜스크립트", "トランスクリプト"),
    liveRuns: tr("Live Runs", "라이브 실행", "ライブ実行"),
    liveRunsBody: tr("Compact live transcript stream for the issue detail page.", "이슈 상세 페이지용 compact live transcript 스트림입니다.", "issue 詳細ページ向けの compact live transcript ストリームです。"),
    openRun: tr("Open run", "실행 열기", "実行を開く"),
    liveNow: tr("Live now", "지금 라이브", "ただいまライブ"),
    finishedAgo: tr("Finished 2m ago", "2분 전에 종료됨", "2分前に完了"),
    controls: tr("Controls", "제어", "コントロール"),
    showSettled: tr("Show settled state", "정착된 상태 보기", "完了状態を表示"),
    showStreaming: tr("Show streaming state", "스트리밍 상태 보기", "ストリーミング状態を表示"),
    nice: tr("Nice", "정리된 보기", "整形表示"),
    raw: tr("Raw", "원본", "生データ"),
    comfortable: tr("Comfortable", "여유형", "ゆったり"),
    compact: tr("Compact", "압축형", "コンパクト"),
  };
}

function previewEntries(surface: SurfaceId) {
  if (surface === "dashboard") {
    return runTranscriptFixtureEntries.slice(-9);
  }
  if (surface === "live") {
    return runTranscriptFixtureEntries.slice(-14);
  }
  return runTranscriptFixtureEntries;
}

function RunDetailPreview({
  mode,
  streaming,
  density,
}: {
  mode: TranscriptMode;
  streaming: boolean;
  density: TranscriptDensity;
}) {
  const copy = useLabCopy();
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-background/80 shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
      <div className="border-b border-border/60 bg-background/90 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="uppercase tracking-[0.18em] text-[10px]">
            {copy.runDetail}
          </Badge>
          <StatusBadge status={streaming ? "running" : "succeeded"} />
          <span className="text-xs text-muted-foreground">
            {formatDateTime(runTranscriptFixtureMeta.startedAt)}
          </span>
        </div>
        <div className="mt-2 text-sm font-medium">
          {copy.transcript} ({runTranscriptFixtureEntries.length})
        </div>
      </div>
      <div className="max-h-[720px] overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(8,145,178,0.08),transparent_36%),radial-gradient(circle_at_bottom_right,rgba(245,158,11,0.10),transparent_28%)] p-5">
        <RunTranscriptView
          entries={runTranscriptFixtureEntries}
          mode={mode}
          density={density}
          streaming={streaming}
        />
      </div>
    </div>
  );
}

function LiveWidgetPreview({
  streaming,
  mode,
  density,
}: {
  streaming: boolean;
  mode: TranscriptMode;
  density: TranscriptDensity;
}) {
  const copy = useLabCopy();
  return (
    <div className="overflow-hidden rounded-xl border border-cyan-500/25 bg-background/85 shadow-[0_20px_50px_rgba(6,182,212,0.10)]">
      <div className="border-b border-border/60 bg-cyan-500/[0.05] px-5 py-4">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700 dark:text-cyan-300">
          {copy.liveRuns}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {copy.liveRunsBody}
        </div>
      </div>
      <div className="px-5 py-4">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Identity name={runTranscriptFixtureMeta.agentName} size="sm" />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-full border border-border/70 bg-background/70 px-2 py-1 font-mono">
                {runTranscriptFixtureMeta.sourceRunId.slice(0, 8)}
              </span>
              <StatusBadge status={streaming ? "running" : "succeeded"} />
              <span>{formatDateTime(runTranscriptFixtureMeta.startedAt)}</span>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
            {copy.openRun}
            <ExternalLink className="h-3 w-3" />
          </span>
        </div>
        <div className="max-h-[460px] overflow-y-auto pr-1">
          <RunTranscriptView
            entries={previewEntries("live")}
            mode={mode}
            density={density}
            limit={density === "compact" ? 10 : 12}
            streaming={streaming}
          />
        </div>
      </div>
    </div>
  );
}

function DashboardPreview({
  streaming,
  mode,
  density,
}: {
  streaming: boolean;
  mode: TranscriptMode;
  density: TranscriptDensity;
}) {
  const copy = useLabCopy();
  return (
    <div className="max-w-md">
      <div className={cn(
        "flex h-[320px] flex-col overflow-hidden rounded-xl border shadow-[0_20px_40px_rgba(15,23,42,0.10)]",
        streaming
          ? "border-cyan-500/25 bg-cyan-500/[0.04]"
          : "border-border bg-background/75",
      )}>
        <div className="border-b border-border/60 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "inline-flex h-2.5 w-2.5 rounded-full",
                  streaming ? "bg-cyan-500 shadow-[0_0_0_6px_rgba(34,211,238,0.12)]" : "bg-muted-foreground/35",
                )} />
                <Identity name={runTranscriptFixtureMeta.agentName} size="sm" />
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                {streaming ? copy.liveNow : copy.finishedAgo}
              </div>
            </div>
            <span className="rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
              <ExternalLink className="h-2.5 w-2.5" />
            </span>
          </div>
          <div className="mt-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs text-cyan-700 dark:text-cyan-300">
            {runTranscriptFixtureMeta.issueIdentifier} - {runTranscriptFixtureMeta.issueTitle}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <RunTranscriptView
            entries={previewEntries("dashboard")}
            mode={mode}
            density={density}
            limit={density === "compact" ? 6 : 8}
            streaming={streaming}
          />
        </div>
      </div>
    </div>
  );
}

export function RunTranscriptUxLab() {
  const copy = useLabCopy();
  const [selectedSurface, setSelectedSurface] = useState<SurfaceId>("detail");
  const [detailMode, setDetailMode] = useState<TranscriptMode>("nice");
  const [streaming, setStreaming] = useState(true);
  const [density, setDensity] = useState<TranscriptDensity>("comfortable");

  const selected = copy.surfaceOptions.find((option) => option.id === selectedSurface) ?? copy.surfaceOptions[0];

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-[linear-gradient(135deg,rgba(8,145,178,0.08),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.08),transparent_40%),var(--background)] shadow-[0_28px_70px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="border-b border-border/60 bg-background/75 p-5 lg:border-b-0 lg:border-r">
            <div className="mb-5">
              <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-500/[0.08] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-700 dark:text-cyan-300">
                <FlaskConical className="h-3.5 w-3.5" />
                {copy.uxLab}
              </div>
              <h1 className="mt-4 text-2xl font-semibold tracking-tight">{copy.pageTitle}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {copy.pageBody}
              </p>
            </div>

            <div className="space-y-2">
              {copy.surfaceOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setSelectedSurface(option.id)}
                    className={cn(
                      "w-full rounded-xl border px-4 py-3 text-left transition-all",
                      selectedSurface === option.id
                        ? "border-cyan-500/35 bg-cyan-500/[0.10] shadow-[0_12px_24px_rgba(6,182,212,0.12)]"
                        : "border-border/70 bg-background/70 hover:border-cyan-500/20 hover:bg-cyan-500/[0.04]",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span className="rounded-lg border border-current/15 p-2 text-cyan-700 dark:text-cyan-300">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                          {option.eyebrow}
                        </span>
                        <span className="mt-1 block text-sm font-medium">{option.label}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="min-w-0 p-5">
            <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  {selected.eyebrow}
                </div>
                <h2 className="mt-1 text-2xl font-semibold">{selected.label}</h2>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  {selected.description}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
                  Source run {runTranscriptFixtureMeta.sourceRunId.slice(0, 8)}
                </Badge>
                <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
                  {runTranscriptFixtureMeta.issueIdentifier}
                </Badge>
              </div>
            </div>

            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {copy.controls}
              </span>
              <div className="inline-flex rounded-full border border-border/70 bg-background/80 p-1">
                {(["nice", "raw"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                      detailMode === mode ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setDetailMode(mode)}
                  >
                    {mode === "nice" ? copy.nice : copy.raw}
                  </button>
                ))}
              </div>
              <div className="inline-flex rounded-full border border-border/70 bg-background/80 p-1">
                {(["comfortable", "compact"] as const).map((nextDensity) => (
                  <button
                    key={nextDensity}
                    type="button"
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                      density === nextDensity ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setDensity(nextDensity)}
                  >
                    {nextDensity === "comfortable" ? copy.comfortable : copy.compact}
                  </button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => setStreaming((value) => !value)}
              >
                {streaming ? copy.showSettled : copy.showStreaming}
              </Button>
            </div>

            {selectedSurface === "detail" ? (
              <div className={cn(density === "compact" && "max-w-5xl")}>
                <RunDetailPreview mode={detailMode} streaming={streaming} density={density} />
              </div>
            ) : selectedSurface === "live" ? (
              <div className={cn(density === "compact" && "max-w-4xl")}>
                <LiveWidgetPreview streaming={streaming} mode={detailMode} density={density} />
              </div>
            ) : (
              <DashboardPreview streaming={streaming} mode={detailMode} density={density} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
