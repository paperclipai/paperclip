import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ChevronDown,
  Clock,
  Copy,
  FileText,
  ListTree,
  Terminal,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusBadge } from "@/components/StatusBadge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { nav, orchestrationInjectionPage } from "@/lib/i18n";
import { RUN_LIST_PATH } from "@/lib/run-routes";
import { cn } from "@/lib/utils";

type ExpertView = "prompt" | "friendly" | "raw" | "json-context" | "json-wake" | "json-invoke" | "json-result";

const MOCK_RUN_ID = "101c048a-0000-4000-8000-000000000001";

const PROMPT_BLOCKS = [
  { id: "bootstrap", status: "带入" as const, size: "~1.2k 字", summary: "公司边界、工具表骨架" },
  { id: "wake", status: "带入" as const, size: "~480 字", summary: "事务标题 + 翻译目标路径" },
  { id: "session_handoff", status: "带入" as const, size: "~320 字", summary: "会话交接摘要" },
  { id: "task_context", status: "带入" as const, size: "~900 字", summary: "执行单约束、输出路径" },
  { id: "skill_note", status: "指针" as const, size: "1 行", summary: "指向技能说明文件" },
  { id: "heartbeat_template", status: "省略" as const, size: "—", summary: "续跑模式下省略注入" },
] as const;

const CLI_ROWS = [
  {
    name: "单次打印",
    arg: "--print",
    value: "开",
    desc: "单次执行结束后进程退出，便于控制面回收",
    source: "代码固定",
  },
  {
    name: "输出格式",
    arg: "--output-format",
    value: "stream-json",
    desc: "流式输出：执行期间持续写入日志，运行详情可同步呈现",
    source: "适配器配置；未改时用 stream-json",
  },
  {
    name: "选择模型",
    arg: "--model",
    value: "glm-5.1",
    desc: "本次运行使用的模型",
    source: "智能体配置",
  },
  {
    name: "流式半包",
    arg: "--include-partial-messages",
    value: "开",
    desc: "允许推送未完整的中间消息，降低流式延迟",
    source: "选用流式输出时自动追加",
  },
  {
    name: "智能体设定",
    arg: "--system-prompt-file",
    value: "AGENTS.md",
    desc: "智能体设定包（人设、规则等），冷启动注入当前入口文件；续跑不重复注入",
    source: "agent-settings",
  },
] as const;

function promptSectionLabel(sectionId: string): string {
  const titles = orchestrationInjectionPage.promptSectionTitles;
  return sectionId in titles ? titles[sectionId as keyof typeof titles] : sectionId;
}

function PropertyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm">{value}</span>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums tracking-tight">{value}</div>
    </div>
  );
}

function BlockStatusBadge({ status }: { status: "带入" | "指针" | "省略" }) {
  if (status === "省略") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground line-through opacity-70">
        省略
      </Badge>
    );
  }
  if (status === "指针") {
    return (
      <Badge variant="secondary" className="font-normal">
        指针
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-normal">
      带入
    </Badge>
  );
}

function NarrativeCard({
  id,
  title,
  description,
  icon: Icon,
  children,
  footer,
}: {
  id: string;
  title: string;
  description: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-4 gap-0 py-0 shadow-none">
      <div className="flex flex-wrap items-end gap-x-2 gap-y-0 border-b px-6 py-3">
        {Icon ? (
          <Icon className="mb-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : null}
        <CardTitle className="shrink-0 text-sm font-medium leading-none">{title}</CardTitle>
        <CardDescription className="min-w-0 flex-1 pb-px text-xs leading-none">{description}</CardDescription>
      </div>
      <CardContent className={cn("space-y-3 px-6 pt-3", footer && "pb-3")}>{children}</CardContent>
      {footer ? (
        <CardFooter className="flex flex-wrap gap-2 border-t px-6 py-3 [.border-t]:pt-3">{footer}</CardFooter>
      ) : null}
    </Card>
  );
}

function DataTable({
  columns,
  rows,
  monoColumns = [],
}: {
  columns: string[];
  rows: ReactNode[][];
  monoColumns?: number[];
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border bg-accent/20">
            {columns.map((col) => (
              <th key={col} className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-border transition-colors last:border-b-0 hover:bg-accent/20"
            >
              {cells.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn(
                    "px-3 py-2.5 align-top",
                    cellIndex === 0 ? "text-sm font-medium" : "text-sm",
                    monoColumns.includes(cellIndex) && "font-mono text-xs text-muted-foreground",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EXPERT_TITLES: Record<ExpertView, string> = {
  prompt: orchestrationInjectionPage.finalPrompt,
  friendly: "友好转写",
  raw: "原始流",
  "json-context": orchestrationInjectionPage.contextSnapshot,
  "json-wake": orchestrationInjectionPage.wakePayload,
  "json-invoke": orchestrationInjectionPage.adapterInvocation,
  "json-result": "结构化回传",
};

const EXPERT_BODY: Record<ExpertView, string> = {
  prompt: "你是 T5 执行智能体，负责在仓库内完成翻译任务…\n\n## 任务\n将 releases/v2026.318.0.md 译为中文…",
  friendly: "[lifecycle] 子进程已启动\n[stdout] 正在读取 releases/v2026.318.0.md …\n[stdout] 写入中文译文 …\n[lifecycle] 正常退出 · exit 0",
  raw: '{"type":"stream_event","subtype":"started"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}',
  "json-context": '{\n  "wakeReason": "issue_assigned",\n  "issueId": "de9e5300-…"\n}',
  "json-wake": '{\n  "issueKey": "ROU-6",\n  "title": "翻译 releases/v2026.318.0.md"\n}',
  "json-invoke": '{\n  "command": "codebuddy … --print --output-format stream-json",\n  "cwd": "/workspace/paperclip-routic"\n}',
  "json-result": '{\n  "exitCode": 0,\n  "filesChanged": ["releases/v2026.318.0.zh.md"]\n}',
};

export function RunDetailNarrativePreview() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [expertOpen, setExpertOpen] = useState(false);
  const [expertView, setExpertView] = useState<ExpertView>("prompt");

  useEffect(() => {
    setBreadcrumbs([
      { label: nav.work },
      { label: nav.orchestrationInjection, href: RUN_LIST_PATH },
      { label: orchestrationInjectionPage.runDetailBreadcrumb(`${MOCK_RUN_ID.slice(0, 8)}…`) },
    ]);
  }, [setBreadcrumbs]);

  const openExpert = useCallback((view: ExpertView) => {
    setExpertView(view);
    setExpertOpen(true);
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-lg border border-border p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <StatusBadge status="succeeded" />
              <span className="font-mono text-xs text-muted-foreground">{MOCK_RUN_ID.slice(0, 8)}…</span>
            </div>
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">{orchestrationInjectionPage.agent}</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  <Link to="/agents/all" className="text-primary hover:underline">
                    T5 执行
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">适配器</dt>
                <dd className="mt-0.5 text-sm font-medium">CodeBuddy 本地</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">时长</dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums">2 分 45 秒</dd>
              </div>
            </dl>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  深读
                  <ChevronDown className="ml-1 h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => openExpert("prompt")}>最终提示词</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openExpert("friendly")}>友好转写</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openExpert("raw")}>原始流</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => openExpert("json-context")}>运行快照（JSON）</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openExpert("json-wake")}>唤醒载荷（JSON）</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openExpert("json-invoke")}>完整命令行</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openExpert("json-result")}>结构化回传（JSON）</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="sm">
              <Copy className="mr-1.5 h-4 w-4" aria-hidden />
              复制运行 ID
            </Button>
          </div>
        </div>
      </div>

      <NarrativeCard
        id="source"
        title="运行来源"
        description="本轮运行如何产生 — 调整唤醒与派工策略时查阅"
        icon={Activity}
        footer={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/issues/all">打开事务</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/agents/all">智能体运行页</Link>
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">
          本次由<strong className="font-medium">分配交办</strong>触发：董事会通过系统规则将事务{" "}
          <strong className="font-medium">ROU-6</strong> 指派至 <strong className="font-medium">T5 执行</strong>
          ，随后人工按需启动本次运行并完成翻译任务。
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            开始 <span className="font-medium tabular-nums text-foreground">10:42:19</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            结束 <span className="font-medium tabular-nums text-foreground">10:45:04</span>
          </span>
        </div>
        <div className="rounded-md border border-border bg-muted/15 px-3 py-1">
          <PropertyRow label="派工原因" value="事务创建后分配经办（非多路合并）" />
          <PropertyRow
            label="关联事务"
            value={
              <Link to="/issues/all" className="text-primary hover:underline">
                ROU-6 · 翻译 releases/v2026.318.0.md
              </Link>
            }
          />
        </div>
      </NarrativeCard>

      <NarrativeCard
        id="input"
        title="输入编排"
        description="控制面如何组装本轮输入 — 提示词段清单（最终提示词全文见深读）"
        icon={ListTree}
        footer={
          <Button variant="outline" size="sm" onClick={() => openExpert("prompt")}>
            查看最终提示词全文
          </Button>
        }
      >
        <div className="space-y-2 rounded-md border border-border bg-muted/15 p-3 text-xs leading-relaxed">
          <p className="font-medium text-foreground">{orchestrationInjectionPage.promptCacheCorrelationTitle}</p>
          <p className="text-muted-foreground">{orchestrationInjectionPage.promptCacheModeResumed}</p>
          <p className="text-muted-foreground">
            {orchestrationInjectionPage.promptCacheStabilityKeyLabel}：
            <code className="ml-1 font-mono text-[11px] text-foreground">issue:de9e5300…</code>
          </p>
        </div>
        <DataTable
          columns={["提示词段", "状态", "体量", "摘要"]}
          monoColumns={[2]}
          rows={PROMPT_BLOCKS.map((row) => [
            promptSectionLabel(row.id),
            <BlockStatusBadge key={`${row.id}-status`} status={row.status} />,
            row.size,
            <span className="font-normal text-muted-foreground">{row.summary}</span>,
          ])}
        />
      </NarrativeCard>

      <NarrativeCard
        id="execution"
        title="执行与回传"
        description="适配器执行方式 — 命令参数逐项说明（参数名可保留英文）"
        icon={Terminal}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => openExpert("friendly")}>
              查看完整友好转写
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openExpert("json-invoke")}>
              完整命令行
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          CodeBuddy 无头单次执行 · 流式输出 · 模型{" "}
          <code className="font-mono text-xs text-foreground">glm-5.1</code> · 工作目录为本仓库根
        </p>
        <DataTable
          columns={["命令名称", "参数", "本 run 取值", "说明", "来源"]}
          monoColumns={[1, 2]}
          rows={CLI_ROWS.map((row) => [
            row.name,
            row.arg,
            row.value,
            <span className="font-normal text-muted-foreground">{row.desc}</span>,
            row.source === "agent-settings" ? (
              <Link to="/agents/all" className="font-normal text-primary hover:underline">
                智能体 · 设定
              </Link>
            ) : (
              <span className="font-normal text-muted-foreground">{row.source}</span>
            ),
          ])}
        />
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">转写预览（友好）</p>
          <pre className="max-h-28 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
            {EXPERT_BODY.friendly}
          </pre>
        </div>
      </NarrativeCard>

      <NarrativeCard
        id="outcome"
        title="结果"
        description="本轮交回什么 — 终态、用量与结构化回传摘要"
        icon={Workflow}
        footer={
          <Button variant="outline" size="sm" onClick={() => openExpert("json-result")}>
            查看完整结构化回传（JSON）
          </Button>
        }
      >
        <div className="overflow-hidden rounded-md border border-border sm:grid sm:grid-cols-2 xl:grid-cols-5 xl:divide-x">
          <StatCell label={orchestrationInjectionPage.status} value="成功" />
          <StatCell label="退出码" value="0" />
          <StatCell label="输入 Token" value="12.4k" />
          <StatCell label="输出 Token" value="3.1k" />
          <StatCell label="缓存读取 Token" value="8.2k" />
        </div>
        <div className="rounded-md border border-border bg-muted/15 px-3 py-1">
          <PropertyRow
            label="结构化回传摘要"
            value="变更文件 1 个 · releases/v2026.318.0.zh.md · 事务评论已回写"
          />
        </div>
      </NarrativeCard>

      <Sheet open={expertOpen} onOpenChange={setExpertOpen}>
        <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
              {EXPERT_TITLES[expertView]}
            </SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pt-4">
            <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
              {EXPERT_BODY[expertView]}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
