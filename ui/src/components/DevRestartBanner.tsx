import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import type { DevServerHealthStatus } from "../api/health";
import { useI18n } from "../i18n";

function formatRelativeTimestamp(value: string | null, locale: "en" | "ko" | "ja"): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return locale === "ko" ? "방금 전" : locale === "ja" ? "たった今" : "just now";
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return locale === "ko" ? `${deltaMinutes}분 전` : locale === "ja" ? `${deltaMinutes}分前` : `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return locale === "ko" ? `${deltaHours}시간 전` : locale === "ja" ? `${deltaHours}時間前` : `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return locale === "ko" ? `${deltaDays}일 전` : locale === "ja" ? `${deltaDays}日前` : `${deltaDays}d ago`;
}

function describeReason(devServer: DevServerHealthStatus, locale: "en" | "ko" | "ja"): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return locale === "ko"
      ? "백엔드 파일이 바뀌었고 마이그레이션이 대기 중입니다"
      : locale === "ja"
        ? "バックエンドファイルが変更され、migration が保留中です"
        : "backend files changed and migrations are pending";
  }
  if (devServer.reason === "pending_migrations") {
    return locale === "ko"
      ? "대기 중인 마이그레이션 때문에 새로 부팅해야 합니다"
      : locale === "ja"
        ? "保留中の migration のため新しい boot が必要です"
        : "pending migrations need a fresh boot";
  }
  return locale === "ko"
    ? "이 서버가 부팅된 뒤 백엔드 파일이 변경되었습니다"
    : locale === "ja"
      ? "このサーバーの起動後にバックエンドファイルが変更されました"
      : "backend files changed since this server booted";
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const { locale } = useI18n();
  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt, locale);
  const sample = devServer.changedPathsSample.slice(0, 3);
  const copy = locale === "ko"
    ? {
        restartRequired: "재시작 필요",
        autoRestartOn: "자동 재시작 켜짐",
        updated: "업데이트",
        changed: "변경됨",
        more: "개 더",
        pendingMigrations: "대기 중인 마이그레이션",
        waitingForRuns: `${devServer.activeRunCount}개 live run 종료 대기 중`,
        autoRestartIdle: "인스턴스가 유휴 상태가 되면 자동 재시작됩니다",
        restartWhenSafe: "현재 작업을 중단해도 안전할 때 \`pnpm dev:once\`를 다시 시작하세요",
      }
    : locale === "ja"
      ? {
          restartRequired: "再起動が必要",
          autoRestartOn: "自動再起動オン",
          updated: "更新",
          changed: "変更",
          more: "件追加",
          pendingMigrations: "保留中の migration",
          waitingForRuns: `${devServer.activeRunCount} 件の live run が終わるのを待機中`,
          autoRestartIdle: "インスタンスが idle になると自動再起動されます",
          restartWhenSafe: "現在の作業を中断しても安全になったら \`pnpm dev:once\` を再起動してください",
        }
      : {
          restartRequired: "Restart Required",
          autoRestartOn: "Auto-Restart On",
          updated: "updated",
          changed: "Changed",
          more: "more",
          pendingMigrations: "Pending migrations",
          waitingForRuns: `Waiting for ${devServer.activeRunCount} live run${devServer.activeRunCount === 1 ? "" : "s"} to finish`,
          autoRestartIdle: "Auto-restart will trigger when the instance is idle",
          restartWhenSafe: "Restart \`pnpm dev:once\` after the active work is safe to interrupt",
        };

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{copy.restartRequired}</span>
            {devServer.autoRestartEnabled ? (
              <span className="rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-[0.14em] dark:bg-amber-100/10">
                {copy.autoRestartOn}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer, locale)}
            {changedAt ? ` · ${copy.updated} ${changedAt}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>
                {copy.changed}: {sample.join(", ")}
                {devServer.changedPathCount > sample.length ? ` +${devServer.changedPathCount - sample.length} ${copy.more}` : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                {copy.pendingMigrations}: {devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2 ? ` +${devServer.pendingMigrations.length - 2} ${copy.more}` : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>{copy.waitingForRuns}</span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{copy.autoRestartIdle}</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{copy.restartWhenSafe}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
