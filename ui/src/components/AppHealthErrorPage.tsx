import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";

const RECOVERY_STEPS = [
  {
    step: "1",
    title: "先檢查",
    detail: "跑 office:check，確認是前端、後端 health，還是 postmaster.pid 卡住。",
    report: "Run pnpm run office:check and copy the recovery hints.",
  },
  {
    step: "2",
    title: "再重啟",
    detail: "若後端仍不健康，跑 office:restart，再回來按重新檢查後端。",
    report: "Run pnpm run office:restart if the backend is still unhealthy.",
  },
  {
    step: "3",
    title: "還卡才重開機",
    detail: "若 shared memory 或 lock file 還在，重開 Windows；不要手動刪資料庫檔。",
    report: "Reboot Windows if embedded Postgres shared memory is still stuck.",
  },
];

const SAFE_WHILE_BACKEND_DOWN = ["看復原說明與教學文件", "複製狀態紀錄貼回驗收", "跑完 helper 後重新檢查 health"];

const PAUSE_WHILE_BACKEND_DOWN = ["建立員工或工作流", "同步 skills 或開會議任務", "保存、停用或清理資料"];

const RESUME_GATES = ["前端可開 Office 頁", "後端 health 回到 status: ok", "沒有 postmaster.pid 警告"];

const IMPORTANT_RECOVERY_LOCATIONS = [
  { label: "Office 頁面", value: "http://localhost:5173/AI/office" },
  { label: "後端 health", value: "http://127.0.0.1:3100/api/health" },
  { label: "復原 SOP", value: "docs/virtual-office-startup-sop.zh-TW.md" },
  { label: "資料庫鎖檔", value: "C:\\Users\\<you>\\.paperclip\\instances\\default\\db\\postmaster.pid" },
];

const SHUTDOWN_CHECKS = ["確認沒有正在建立、同步、保存或停用", "關掉不需要的預覽頁面", "保留這份狀態摘要，方便下次接續"];

const STARTUP_CHECKS = [
  "先跑 office:check，不要急著開多個服務",
  "health 回到 status: ok 再驗收資料變更",
  "若仍有 postmaster.pid，照 SOP 重啟或重開 Windows",
];

const CODEX_HELP_PROMPT =
  "請依照 docs/virtual-office-startup-sop.zh-TW.md 幫我檢查 Virtual Office 預覽。先跑只檢查模式，確認前端、後端 health、postmaster.pid 與殘留程序；不要刪資料庫檔案，也不要按建立、同步、保存、停用或清理資料。";

export function AppHealthErrorPage({
  errorMessage,
  isRetrying,
  isVirtualOfficeRoute,
  onRetry,
}: {
  errorMessage: string;
  isRetrying: boolean;
  isVirtualOfficeRoute: boolean;
  onRetry: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const recoveryReport = [
    "# Paperclip Preview Recovery",
    "",
    `- Route: ${isVirtualOfficeRoute ? "Virtual Office" : "Paperclip app"}`,
    `- Error: ${errorMessage}`,
    ...RECOVERY_STEPS.map((step) => `- Step ${step.step}: ${step.report}`),
    `- Safe while backend is down: ${SAFE_WHILE_BACKEND_DOWN.join("; ")}.`,
    `- Pause while backend is down: ${PAUSE_WHILE_BACKEND_DOWN.join("; ")}.`,
    `- Before shutdown: ${SHUTDOWN_CHECKS.join("; ")}.`,
    `- After startup: ${STARTUP_CHECKS.join("; ")}.`,
    `- Continue only when: ${RESUME_GATES.join("; ")}.`,
    "- Check: pnpm run office:check",
    "- Restart: pnpm run office:restart",
    ...IMPORTANT_RECOVERY_LOCATIONS.map((item) => `- ${item.label}: ${item.value}`),
    "- SOP: docs/virtual-office-startup-sop.zh-TW.md",
    "- Note: Do not manually delete the embedded Postgres database folder or postmaster.pid.",
    "",
    "Help prompt:",
    CODEX_HELP_PROMPT,
  ].join("\n");

  async function copyRecoveryReport() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard is not available.");
      }
      await navigator.clipboard.writeText(recoveryReport);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="mx-auto max-w-2xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
          Preview service check
        </div>
        <h1 className="mt-3 text-xl font-semibold">
          {isVirtualOfficeRoute ? "Virtual Office 後端還沒準備好" : "Paperclip backend is not ready"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          前端畫面服務還在，但後端 health 檢查失敗。先不要測建立、同步、保存或停用；等 health 回到
          <code className="mx-1 rounded bg-muted px-1 py-0.5">status: ok</code>
          後再做會改資料的驗收。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={onRetry} disabled={isRetrying}>
            {isRetrying ? "檢查中..." : "重新檢查後端"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
            重新載入頁面
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={copyRecoveryReport}>
            複製狀態紀錄
          </Button>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">可貼回紀錄的狀態摘要</div>
            {copyState !== "idle" ? (
              <span className="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {copyState === "copied" ? "已複製" : "剪貼簿不可用，可手動選取"}
              </span>
            ) : null}
          </div>
          <pre className="mt-2 max-h-44 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{recoveryReport}
          </pre>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {RECOVERY_STEPS.map((item) => (
            <div key={item.step} className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                  {item.step}
                </span>
                <div className="text-sm font-medium">{item.title}</div>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
            <div className="text-sm font-medium text-emerald-700">現在可以做</div>
            <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
              {SAFE_WHILE_BACKEND_DOWN.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
            <div className="text-sm font-medium text-destructive">先不要做</div>
            <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
              {PAUSE_WHILE_BACKEND_DOWN.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-4 rounded-md border border-primary/30 bg-primary/10 p-3">
          <div className="text-sm font-medium text-primary">恢復後才繼續</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {RESUME_GATES.map((item) => (
              <div key={item} className="rounded-md border border-border/70 bg-background/80 p-2 text-xs text-muted-foreground">
                {item}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            三個條件都符合後，再從測試資料或 Sandbox 批次開始驗收資料變更。
          </p>
        </div>
        <div className="mt-4 rounded-md border border-border/70 bg-background p-3">
          <div className="text-sm font-medium">重要位置</div>
          <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-[120px_minmax(0,1fr)]">
            {IMPORTANT_RECOVERY_LOCATIONS.map((item) => (
              <Fragment key={item.label}>
                <dt className="text-muted-foreground">{item.label}</dt>
                <dd className="break-all rounded-md bg-muted/30 px-2 py-1">{item.value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
        <div className="mt-4 rounded-md border border-sky-500/30 bg-sky-500/10 p-3">
          <div className="text-sm font-medium text-sky-700">貼給 Codex 的求助文字</div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{CODEX_HELP_PROMPT}</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border/70 bg-background p-3">
            <div className="text-sm font-medium">關機前</div>
            <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
              {SHUTDOWN_CHECKS.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-md border border-border/70 bg-background p-3">
            <div className="text-sm font-medium">開機後</div>
            <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
              {STARTUP_CHECKS.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border/70 bg-background p-3">
            <div className="text-sm font-medium">先跑檢查</div>
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm run office:check`}
            </pre>
          </div>
          <div className="rounded-md border border-border/70 bg-background p-3">
            <div className="text-sm font-medium">需要重啟時</div>
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm run office:restart`}
            </pre>
          </div>
        </div>
        <div className="mt-4 rounded-md border border-border/70 bg-background p-3 text-sm">
          <div className="font-medium">看到 postmaster.pid 時</div>
          <p className="mt-2 leading-6 text-muted-foreground">
            不要手動刪資料庫資料夾或 lock file。先照
            <code className="mx-1 rounded bg-muted px-1 py-0.5">docs/virtual-office-startup-sop.zh-TW.md</code>
            的順序處理；如果 helper 仍顯示 shared memory 卡住，重開 Windows 後再試。
          </p>
        </div>
        <p className="mt-4 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {errorMessage}
        </p>
      </div>
    </div>
  );
}
