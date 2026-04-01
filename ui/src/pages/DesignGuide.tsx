import { useState } from "react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Command as CommandIcon,
  DollarSign,
  Hexagon,
  History,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Mail,
  Plus,
  Search,
  Settings,
  Target,
  Trash2,
  Upload,
  User,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { PriorityIcon } from "@/components/PriorityIcon";
import { agentStatusDot, agentStatusDotDefault } from "@/lib/status-colors";
import { EntityRow } from "@/components/EntityRow";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { InlineEditor } from "@/components/InlineEditor";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Identity } from "@/components/Identity";
import { useI18n } from "../i18n";

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      <Separator />
      {children}
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Color swatch                                                       */
/* ------------------------------------------------------------------ */

function Swatch({ name, cssVar }: { name: string; cssVar: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-8 w-8 rounded-md border border-border shrink-0"
        style={{ backgroundColor: `var(${cssVar})` }}
      />
      <div>
        <p className="text-xs font-mono">{cssVar}</p>
        <p className="text-xs text-muted-foreground">{name}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function DesignGuide() {
  const { locale } = useI18n();
  const copy = locale === "ko"
    ? {
        pageTitle: "디자인 가이드",
        pageSubtitle: "Paperclip 전반에서 쓰는 컴포넌트, 스타일, 패턴 모음입니다.",
        componentCoverage: "컴포넌트 커버리지",
        componentCoverageDesc: "새 UI primitive나 앱 레벨 패턴이 추가되면 이 페이지도 함께 업데이트해야 합니다.",
        uiPrimitives: "UI 프리미티브",
        appComponents: "앱 컴포넌트",
        colors: "색상",
        core: "핵심",
        sidebar: "사이드바",
        chart: "차트",
        typography: "타이포그래피",
        radius: "라운드",
        buttons: "버튼",
        variants: "변형",
        sizes: "크기",
        iconButtons: "아이콘 버튼",
        withIcons: "아이콘 포함",
        states: "상태",
        badges: "배지",
        statusSystem: "상태 시스템",
        formElements: "폼 요소",
        select: "셀렉트",
        dropdownMenu: "드롭다운 메뉴",
        popover: "팝오버",
        collapsible: "접기/펼치기",
        sheet: "시트",
        scrollArea: "스크롤 영역",
        command: "커맨드(CMDK)",
        breadcrumb: "브레드크럼",
        cards: "카드",
        tabs: "탭",
        entityRows: "엔티티 행",
        filterBar: "필터 바",
        avatars: "아바타",
        identity: "아이덴티티",
        tooltips: "툴팁",
        dialog: "다이얼로그",
        emptyState: "빈 상태",
        progressBars: "진행 바 (예산)",
        logViewer: "로그 뷰어",
        propertyRowPattern: "속성 행 패턴",
        navigationPatterns: "네비게이션 패턴",
        groupedListPattern: "그룹 리스트 패턴 (이슈)",
        commentThreadPattern: "댓글 스레드 패턴",
        costTablePattern: "비용 테이블 패턴",
        skeletons: "스켈레톤",
        separator: "구분선",
        commonIcons: "공통 아이콘 (Lucide)",
        keyboardShortcuts: "키보드 단축키",
      }
    : locale === "ja"
      ? {
          pageTitle: "デザインガイド",
          pageSubtitle: "Paperclip 全体で使われるコンポーネント、スタイル、パターンの一覧です。",
          componentCoverage: "コンポーネントカバレッジ",
          componentCoverageDesc: "新しい UI primitive やアプリレベルのパターンを追加したら、このページも更新してください。",
          uiPrimitives: "UI プリミティブ",
          appComponents: "アプリコンポーネント",
          colors: "カラー",
          core: "コア",
          sidebar: "サイドバー",
          chart: "チャート",
          typography: "タイポグラフィ",
          radius: "角丸",
          buttons: "ボタン",
          variants: "バリエーション",
          sizes: "サイズ",
          iconButtons: "アイコンボタン",
          withIcons: "アイコン付き",
          states: "状態",
          badges: "バッジ",
          statusSystem: "ステータスシステム",
          formElements: "フォーム要素",
          select: "セレクト",
          dropdownMenu: "ドロップダウンメニュー",
          popover: "ポップオーバー",
          collapsible: "折りたたみ",
          sheet: "シート",
          scrollArea: "スクロールエリア",
          command: "コマンド (CMDK)",
          breadcrumb: "パンくず",
          cards: "カード",
          tabs: "タブ",
          entityRows: "エンティティ行",
          filterBar: "フィルターバー",
          avatars: "アバター",
          identity: "アイデンティティ",
          tooltips: "ツールチップ",
          dialog: "ダイアログ",
          emptyState: "空状態",
          progressBars: "進行バー (予算)",
          logViewer: "ログビューア",
          propertyRowPattern: "プロパティ行パターン",
          navigationPatterns: "ナビゲーションパターン",
          groupedListPattern: "グループリストパターン (イシュー)",
          commentThreadPattern: "コメントスレッドパターン",
          costTablePattern: "コストテーブルパターン",
          skeletons: "スケルトン",
          separator: "区切り線",
          commonIcons: "共通アイコン (Lucide)",
          keyboardShortcuts: "キーボードショートカット",
        }
      : {
          pageTitle: "Design Guide",
          pageSubtitle: "Every component, style, and pattern used across Paperclip.",
          componentCoverage: "Component Coverage",
          componentCoverageDesc: "This page should be updated when new UI primitives or app-level patterns ship.",
          uiPrimitives: "UI primitives",
          appComponents: "App components",
          colors: "Colors",
          core: "Core",
          sidebar: "Sidebar",
          chart: "Chart",
          typography: "Typography",
          radius: "Radius",
          buttons: "Buttons",
          variants: "Variants",
          sizes: "Sizes",
          iconButtons: "Icon buttons",
          withIcons: "With icons",
          states: "States",
          badges: "Badges",
          statusSystem: "Status System",
          formElements: "Form Elements",
          select: "Select",
          dropdownMenu: "Dropdown Menu",
          popover: "Popover",
          collapsible: "Collapsible",
          sheet: "Sheet",
          scrollArea: "Scroll Area",
          command: "Command (CMDK)",
          breadcrumb: "Breadcrumb",
          cards: "Cards",
          tabs: "Tabs",
          entityRows: "Entity Rows",
          filterBar: "Filter Bar",
          avatars: "Avatars",
          identity: "Identity",
          tooltips: "Tooltips",
          dialog: "Dialog",
          emptyState: "Empty State",
          progressBars: "Progress Bars (Budget)",
          logViewer: "Log Viewer",
          propertyRowPattern: "Property Row Pattern",
          navigationPatterns: "Navigation Patterns",
          groupedListPattern: "Grouped List (Issues pattern)",
          commentThreadPattern: "Comment Thread Pattern",
          costTablePattern: "Cost Table Pattern",
          skeletons: "Skeletons",
          separator: "Separator",
          commonIcons: "Common Icons (Lucide)",
          keyboardShortcuts: "Keyboard Shortcuts",
        };
  const tr = (en: string, ko: string, ja: string) => locale === "ko" ? ko : locale === "ja" ? ja : en;
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [inlineText, setInlineText] = useState("Click to edit this text");
  const [inlineTitle, setInlineTitle] = useState("Editable Title");
  const [inlineDesc, setInlineDesc] = useState(
    "This is an editable description. Click to edit it — the textarea auto-sizes to fit the content without layout shift."
  );
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: tr("Status", "상태", "状態"), value: tr("Active", "활성", "アクティブ") },
    { key: "priority", label: tr("Priority", "우선순위", "優先度"), value: tr("High", "높음", "高") },
  ]);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">{copy.pageTitle}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {copy.pageSubtitle}
        </p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title={copy.componentCoverage}>
        <p className="text-sm text-muted-foreground">
          {copy.componentCoverageDesc}
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={copy.uiPrimitives}>
            <div className="flex flex-wrap gap-2">
              {[
                "avatar", "badge", "breadcrumb", "button", "card", "checkbox", "collapsible",
                "command", "dialog", "dropdown-menu", "input", "label", "popover", "scroll-area",
                "select", "separator", "sheet", "skeleton", "tabs", "textarea", "tooltip",
              ].map((name) => (
                <Badge key={name} variant="outline" className="font-mono text-[10px]">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
          <SubSection title={copy.appComponents}>
            <div className="flex flex-wrap gap-2">
              {[
                "StatusBadge", "StatusIcon", "PriorityIcon", "EntityRow", "EmptyState", "MetricCard",
                "FilterBar", "InlineEditor", "PageSkeleton", "Identity", "CommentThread", "MarkdownEditor",
                "PropertiesPanel", "Sidebar", "CommandPalette",
              ].map((name) => (
                <Badge key={name} variant="ghost" className="font-mono text-[10px]">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COLORS                                                       */}
      {/* ============================================================ */}
      <Section title={copy.colors}>
        <SubSection title={copy.core}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={tr("Background", "배경", "背景")} cssVar="--background" />
            <Swatch name={tr("Foreground", "전경", "前景")} cssVar="--foreground" />
            <Swatch name={tr("Card", "카드", "カード")} cssVar="--card" />
            <Swatch name={tr("Primary", "기본", "プライマリ")} cssVar="--primary" />
            <Swatch name={tr("Primary foreground", "기본 전경", "プライマリ前景")} cssVar="--primary-foreground" />
            <Swatch name={tr("Secondary", "보조", "セカンダリ")} cssVar="--secondary" />
            <Swatch name={tr("Muted", "약한 강조", "ミュート")} cssVar="--muted" />
            <Swatch name={tr("Muted foreground", "약한 전경", "ミュート前景")} cssVar="--muted-foreground" />
            <Swatch name={tr("Accent", "강조", "アクセント")} cssVar="--accent" />
            <Swatch name={tr("Destructive", "파괴", "破壊")} cssVar="--destructive" />
            <Swatch name={tr("Border", "테두리", "境界線")} cssVar="--border" />
            <Swatch name={tr("Ring", "링", "リング")} cssVar="--ring" />
          </div>
        </SubSection>

        <SubSection title={copy.sidebar}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={tr("Sidebar", "사이드바", "サイドバー")} cssVar="--sidebar" />
            <Swatch name={tr("Sidebar border", "사이드바 테두리", "サイドバー境界線")} cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title={copy.chart}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={tr("Chart 1", "차트 1", "チャート 1")} cssVar="--chart-1" />
            <Swatch name={tr("Chart 2", "차트 2", "チャート 2")} cssVar="--chart-2" />
            <Swatch name={tr("Chart 3", "차트 3", "チャート 3")} cssVar="--chart-3" />
            <Swatch name={tr("Chart 4", "차트 4", "チャート 4")} cssVar="--chart-4" />
            <Swatch name={tr("Chart 5", "차트 5", "チャート 5")} cssVar="--chart-5" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TYPOGRAPHY                                                   */}
      {/* ============================================================ */}
      <Section title={copy.typography}>
        <div className="space-y-3">
          <h2 className="text-xl font-bold">{tr("Page Title", "페이지 제목", "ページタイトル")} - text-xl font-bold</h2>
          <h2 className="text-lg font-semibold">{tr("Section Title", "섹션 제목", "セクションタイトル")} - text-lg font-semibold</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {tr("Section Heading", "섹션 헤딩", "セクション見出し")} - text-sm font-semibold uppercase tracking-wide
          </h3>
          <p className="text-sm font-medium">{tr("Card Title", "카드 제목", "カードタイトル")} - text-sm font-medium</p>
          <p className="text-sm font-semibold">{tr("Card Title Alt", "카드 제목 대안", "カードタイトル代替")} - text-sm font-semibold</p>
          <p className="text-sm">{tr("Body text", "본문 텍스트", "本文テキスト")} - text-sm</p>
          <p className="text-sm text-muted-foreground">
            {tr("Muted description", "보조 설명", "補足説明")} - text-sm text-muted-foreground
          </p>
          <p className="text-xs text-muted-foreground">
            {tr("Tiny label", "작은 라벨", "小さいラベル")} - text-xs text-muted-foreground
          </p>
          <p className="text-sm font-mono text-muted-foreground">
            {tr("Mono identifier", "모노 식별자", "モノ識別子")} - text-sm font-mono text-muted-foreground
          </p>
          <p className="text-2xl font-bold">{tr("Large stat", "큰 수치", "大きな統計")} - text-2xl font-bold</p>
          <p className="font-mono text-xs">{tr("Log/code text", "로그/코드 텍스트", "ログ/コードテキスト")} - font-mono text-xs</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title={copy.radius}>
        <div className="flex items-end gap-4 flex-wrap">
          {[
            ["sm", "var(--radius-sm)"],
            ["md", "var(--radius-md)"],
            ["lg", "var(--radius-lg)"],
            ["xl", "var(--radius-xl)"],
            ["full", "9999px"],
          ].map(([label, radius]) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <div
                className="h-12 w-12 bg-primary"
                style={{ borderRadius: radius }}
              />
              <span className="text-xs text-muted-foreground">{label === "full" ? tr("full", "전체", "full") : label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BUTTONS                                                      */}
      {/* ============================================================ */}
      <Section title={copy.buttons}>
        <SubSection title={copy.variants}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">{tr("Default", "기본", "デフォルト")}</Button>
            <Button variant="secondary">{tr("Secondary", "보조", "セカンダリ")}</Button>
            <Button variant="outline">{tr("Outline", "외곽선", "アウトライン")}</Button>
            <Button variant="ghost">{tr("Ghost", "고스트", "ゴースト")}</Button>
            <Button variant="destructive">{tr("Destructive", "삭제", "破壊")}</Button>
            <Button variant="link">{tr("Link", "링크", "リンク")}</Button>
          </div>
        </SubSection>

        <SubSection title={copy.sizes}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">{tr("Extra Small", "매우 작게", "極小")}</Button>
            <Button size="sm">{tr("Small", "작게", "小")}</Button>
            <Button size="default">{tr("Default", "기본", "デフォルト")}</Button>
            <Button size="lg">{tr("Large", "크게", "大")}</Button>
          </div>
        </SubSection>

        <SubSection title={copy.iconButtons}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title={copy.withIcons}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus /> {tr("New Issue", "새 이슈", "新しい issue")}</Button>
            <Button variant="outline"><Upload /> {tr("Upload", "업로드", "アップロード")}</Button>
            <Button variant="destructive"><Trash2 /> {tr("Delete", "삭제", "削除")}</Button>
            <Button size="sm"><Plus /> {tr("Add", "추가", "追加")}</Button>
          </div>
        </SubSection>

        <SubSection title={copy.states}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>{tr("Disabled", "비활성화", "無効")}</Button>
            <Button variant="outline" disabled>{tr("Disabled Outline", "비활성 외곽선", "無効アウトライン")}</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title={copy.badges}>
        <SubSection title={copy.variants}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{tr("Default", "기본", "デフォルト")}</Badge>
            <Badge variant="secondary">{tr("Secondary", "보조", "セカンダリ")}</Badge>
            <Badge variant="outline">{tr("Outline", "외곽선", "アウトライン")}</Badge>
            <Badge variant="destructive">{tr("Destructive", "삭제", "破壊")}</Badge>
            <Badge variant="ghost">{tr("Ghost", "고스트", "ゴースト")}</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title={copy.statusSystem}>
        <SubSection title={tr("StatusBadge (all statuses)", "StatusBadge (전체 상태)", "StatusBadge (全状態)")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              "active", "running", "paused", "idle", "archived", "planned",
              "achieved", "completed", "failed", "timed_out", "succeeded", "error",
              "pending_approval", "backlog", "todo", "in_progress", "in_review", "blocked",
              "done", "terminated", "cancelled", "pending", "revision_requested",
              "approved", "rejected",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </SubSection>

        <SubSection title={tr("StatusIcon (interactive)", "StatusIcon (상호작용)", "StatusIcon (操作)")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
              (s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <StatusIcon status={s} />
                  <span className="text-xs text-muted-foreground">{s}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusIcon status={status} onChange={setStatus} />
            <span className="text-sm">{tr("Click the icon to change status", "아이콘을 눌러 상태 변경", "アイコンを押して状態を変更")} ({tr("current", "현재", "現在")}: {status})</span>
          </div>
        </SubSection>

        <SubSection title={tr("PriorityIcon (interactive)", "PriorityIcon (상호작용)", "PriorityIcon (操作)")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["critical", "high", "medium", "low"].map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <PriorityIcon priority={p} />
                <span className="text-xs text-muted-foreground">{p}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <PriorityIcon priority={priority} onChange={setPriority} />
            <span className="text-sm">{tr("Click the icon to change", "아이콘을 눌러 변경", "アイコンを押して変更")} ({tr("current", "현재", "現在")}: {priority})</span>
          </div>
        </SubSection>

        <SubSection title={tr("Agent status dots", "에이전트 상태 점", "エージェント状態ドット")}>
          <div className="flex items-center gap-4 flex-wrap">
            {(["running", "active", "paused", "error", "archived"] as const).map((label) => (
              <div key={label} className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`inline-flex h-full w-full rounded-full ${agentStatusDot[label] ?? agentStatusDotDefault}`} />
                </span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title={tr("Run invocation badges", "실행 호출 배지", "実行呼び出しバッジ")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              ["timer", "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"],
              ["assignment", "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"],
              ["on_demand", "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"],
              ["automation", "bg-muted text-muted-foreground"],
            ].map(([label, cls]) => (
              <span key={label} className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
                {label}
              </span>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title={copy.formElements}>
          <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={tr("Input", "입력", "入力")}>
            <Input placeholder={tr("Default input", "기본 입력", "標準入力")} />
            <Input placeholder={tr("Disabled input", "비활성 입력", "無効入力")} disabled className="mt-2" />
          </SubSection>

          <SubSection title={tr("Textarea", "텍스트영역", "テキストエリア")}>
            <Textarea placeholder={tr("Write something...", "내용을 입력하세요...", "何か書いてください...")} />
          </SubSection>

          <SubSection title={tr("Checkbox & Label", "체크박스 & 라벨", "チェックボックス & ラベル")}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">{tr("Checked item", "선택된 항목", "選択済み項目")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">{tr("Unchecked item", "선택 안 된 항목", "未選択項目")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">{tr("Disabled item", "비활성 항목", "無効項目")}</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title={tr("Inline Editor", "인라인 편집기", "インラインエディタ")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{tr("Title (single-line)", "제목 (한 줄)", "タイトル (1 行)")}</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{tr("Body text (single-line)", "본문 텍스트 (한 줄)", "本文テキスト (1 行)")}</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{tr("Description (multiline, auto-sizing)", "설명 (여러 줄, 자동 크기)", "説明 (複数行・自動サイズ)")}</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder={tr("Add a description...", "설명 추가...", "説明を追加...")}
                  multiline
                />
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SELECT                                                       */}
      {/* ============================================================ */}
      <Section title={copy.select}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={tr("Default size", "기본 크기", "標準サイズ")}>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tr("Select status", "상태 선택", "状態を選択")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">{tr("Backlog", "백로그", "バックログ")}</SelectItem>
                <SelectItem value="todo">{tr("Todo", "할 일", "Todo")}</SelectItem>
                <SelectItem value="in_progress">{tr("In Progress", "진행 중", "進行中")}</SelectItem>
                <SelectItem value="in_review">{tr("In Review", "검토 중", "レビュー中")}</SelectItem>
                <SelectItem value="done">{tr("Done", "완료", "完了")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{tr("Current value", "현재 값", "現在の値")}: {selectValue}</p>
          </SubSection>
          <SubSection title={tr("Small trigger", "작은 트리거", "小さいトリガー")}>
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">{tr("Critical", "치명", "重大")}</SelectItem>
                <SelectItem value="high">{tr("High", "높음", "高")}</SelectItem>
                <SelectItem value="medium">{tr("Medium", "보통", "中")}</SelectItem>
                <SelectItem value="low">{tr("Low", "낮음", "低")}</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title={copy.dropdownMenu}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {tr("Quick Actions", "빠른 작업", "クイック操作")}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />
              {tr("Mark as done", "완료로 표시", "完了にする")}
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />
              {tr("Open docs", "문서 열기", "ドキュメントを開く")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >
              {tr("Watch issue", "이슈 주시", "issue を監視")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />
              {tr("Delete issue", "이슈 삭제", "issue を削除")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title={copy.popover}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{tr("Open Popover", "팝오버 열기", "ポップオーバーを開く")}</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">{tr("Agent heartbeat", "에이전트 하트비트", "エージェント heartbeat")}</p>
            <p className="text-xs text-muted-foreground">
              {tr("Last run succeeded 24s ago. Next timer run in 9m.", "마지막 실행은 24초 전에 성공했습니다. 다음 타이머 실행은 9분 뒤입니다.", "前回の実行は 24 秒前に成功しました。次の timer 実行は 9 分後です。")}
            </p>
            <Button size="xs">{tr("Wake now", "지금 깨우기", "今すぐ起動")}</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title={copy.collapsible}>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen ? tr("Hide", "숨기기", "隠す") : tr("Show", "표시", "表示")} {tr("advanced filters", "고급 필터", "高度フィルター")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">{tr("Owner", "소유자", "所有者")}</Label>
              <Input id="owner-filter" placeholder={tr("Filter by agent name", "에이전트 이름으로 필터", "エージェント名で絞り込み")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title={copy.sheet}>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">{tr("Open Side Panel", "사이드 패널 열기", "サイドパネルを開く")}</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{tr("Issue Properties", "이슈 속성", "Issue プロパティ")}</SheetTitle>
              <SheetDescription>{tr("Edit metadata without leaving the current page.", "현재 페이지를 떠나지 않고 메타데이터를 수정합니다.", "現在のページを離れずにメタデータを編集します。")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">{tr("Title", "제목", "タイトル")}</Label>
                <Input id="sheet-title" defaultValue={tr("Improve onboarding docs", "온보딩 문서 개선", "オンボーディング文書を改善")} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">{tr("Description", "설명", "説明")}</Label>
                <Textarea id="sheet-description" defaultValue={tr("Capture setup pitfalls and screenshots.", "설정 함정과 스크린샷을 정리합니다.", "セットアップ時の落とし穴とスクリーンショットをまとめます。")} />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">{tr("Cancel", "취소", "キャンセル")}</Button>
              <Button>{tr("Save", "저장", "保存")}</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title={copy.scrollArea}>
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                {tr("Heartbeat run", "하트비트 실행", "Heartbeat 実行")} #{i + 1}: {tr("completed successfully", "성공적으로 완료됨", "正常に完了")}
              </div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title={copy.command}>
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder={tr("Type a command or search...", "명령을 입력하거나 검색...", "コマンドを入力または検索...")} />
            <CommandList>
              <CommandEmpty>{tr("No results found.", "결과가 없습니다.", "結果が見つかりません。")}</CommandEmpty>
              <CommandGroup heading={tr("Pages", "페이지", "ページ")}>
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />
                  {tr("Dashboard", "대시보드", "ダッシュボード")}
                </CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />
                  {tr("Issues", "이슈", "Issue")}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading={tr("Actions", "작업", "操作")}>
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />
                  {tr("Open command palette", "명령 팔레트 열기", "コマンドパレットを開く")}
                </CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />
                  {tr("Create new issue", "새 이슈 만들기", "新しい issue を作成")}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title={copy.breadcrumb}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{tr("Projects", "프로젝트", "プロジェクト")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Paperclip App</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{tr("Issue List", "이슈 목록", "Issue 一覧")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title={copy.cards}>
        <SubSection title={tr("Standard Card", "표준 카드", "標準カード")}>
          <Card>
            <CardHeader>
              <CardTitle>{tr("Card Title", "카드 제목", "カードタイトル")}</CardTitle>
              <CardDescription>{tr("Card description with supporting text.", "설명을 돕는 보조 텍스트가 있는 카드 설명입니다.", "補足テキスト付きのカード説明です。")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{tr("Card content goes here. This is the main body area.", "카드 내용이 여기에 들어갑니다. 메인 본문 영역입니다.", "カード内容がここに入ります。メイン本文エリアです。")}</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">{tr("Action", "작업", "操作")}</Button>
              <Button variant="outline" size="sm">{tr("Cancel", "취소", "キャンセル")}</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title={tr("Metric Cards", "지표 카드", "メトリクスカード")}>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label={tr("Active Agents", "활성 에이전트", "アクティブエージェント")} description={tr("+3 this week", "이번 주 +3", "今週 +3")} />
            <MetricCard icon={CircleDot} value={48} label={tr("Open Issues", "열린 이슈", "オープン issue")} />
            <MetricCard icon={DollarSign} value="$1,234" label={tr("Monthly Cost", "월간 비용", "月間コスト")} description={tr("Under budget", "예산 이하", "予算内")} />
            <MetricCard icon={Zap} value="99.9%" label={tr("Uptime", "가동 시간", "稼働率")} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title={copy.tabs}>
        <SubSection title={tr("Default (pill) variant", "기본 (pill) 변형", "標準 (pill) バリアント")}>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{tr("Overview", "개요", "概要")}</TabsTrigger>
              <TabsTrigger value="runs">{tr("Runs", "실행", "実行")}</TabsTrigger>
              <TabsTrigger value="config">{tr("Config", "설정", "設定")}</TabsTrigger>
              <TabsTrigger value="costs">{tr("Costs", "비용", "コスト")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">{tr("Overview tab content.", "개요 탭 내용입니다.", "概要タブの内容です。")}</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">{tr("Runs tab content.", "실행 탭 내용입니다.", "実行タブの内容です。")}</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">{tr("Config tab content.", "설정 탭 내용입니다.", "設定タブの内容です。")}</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">{tr("Costs tab content.", "비용 탭 내용입니다.", "コストタブの内容です。")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title={tr("Line variant", "라인 변형", "ラインバリアント")}>
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">{tr("Summary", "요약", "要約")}</TabsTrigger>
              <TabsTrigger value="details">{tr("Details", "상세", "詳細")}</TabsTrigger>
              <TabsTrigger value="comments">{tr("Comments", "댓글", "コメント")}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">{tr("Summary content with underline tabs.", "밑줄 탭이 적용된 요약 내용입니다.", "下線タブ付きの要約内容です。")}</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">{tr("Details content.", "상세 내용입니다.", "詳細内容です。")}</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">{tr("Comments content.", "댓글 내용입니다.", "コメント内容です。")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title={copy.entityRows}>
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                <PriorityIcon priority="high" />
              </>
            }
            identifier="PAP-001"
            title={tr("Implement authentication flow", "인증 흐름 구현", "認証フローを実装")}
            subtitle={tr("Assigned to Agent Alpha", "Agent Alpha에게 할당됨", "Agent Alpha に割り当て")}
            trailing={<StatusBadge status="in_progress" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="done" />
                <PriorityIcon priority="medium" />
              </>
            }
            identifier="PAP-002"
            title={tr("Set up CI/CD pipeline", "CI/CD 파이프라인 구성", "CI/CD パイプラインを構成")}
            subtitle={tr("Completed 2 days ago", "2일 전에 완료됨", "2 日前に完了")}
            trailing={<StatusBadge status="done" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="todo" />
                <PriorityIcon priority="low" />
              </>
            }
            identifier="PAP-003"
            title={tr("Write API documentation", "API 문서 작성", "API ドキュメント作成")}
            trailing={<StatusBadge status="todo" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="blocked" />
                <PriorityIcon priority="critical" />
              </>
            }
            identifier="PAP-004"
            title={tr("Deploy to production", "프로덕션 배포", "本番へデプロイ")}
            subtitle={tr("Blocked by PAP-001", "PAP-001에 의해 차단됨", "PAP-001 によりブロック")}
            trailing={<StatusBadge status="blocked" />}
            selected
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title={copy.filterBar}>
        <FilterBar
          filters={filters}
          onRemove={(key) => setFilters((f) => f.filter((x) => x.key !== key))}
          onClear={() => setFilters([])}
        />
        {filters.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setFilters([
                { key: "status", label: tr("Status", "상태", "状態"), value: tr("Active", "활성", "アクティブ") },
                { key: "priority", label: tr("Priority", "우선순위", "優先度"), value: tr("High", "높음", "高") },
              ])
            }
          >
            {tr("Reset filters", "필터 초기화", "フィルターをリセット")}
          </Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title={copy.avatars}>
        <SubSection title={tr("Sizes", "크기", "サイズ")}>
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>SM</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>DF</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>LG</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title={tr("Group", "그룹", "グループ")}>
          <AvatarGroup>
            <Avatar><AvatarFallback>A1</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A2</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A3</AvatarFallback></Avatar>
            <AvatarGroupCount>+5</AvatarGroupCount>
          </AvatarGroup>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  IDENTITY                                                     */}
      {/* ============================================================ */}
      <Section title={copy.identity}>
        <SubSection title={tr("Sizes", "크기", "サイズ")}>
          <div className="flex items-center gap-6">
            <Identity name="Agent Alpha" size="sm" />
            <Identity name="Agent Alpha" />
            <Identity name="Agent Alpha" size="lg" />
          </div>
        </SubSection>

        <SubSection title={tr("Initials derivation", "이니셜 생성", "イニシャル生成")}>
          <div className="flex flex-col gap-2">
            <Identity name="CEO Agent" size="sm" />
            <Identity name="Alpha" size="sm" />
            <Identity name="Quality Assurance Lead" size="sm" />
          </div>
        </SubSection>

        <SubSection title={tr("Custom initials", "사용자 지정 이니셜", "カスタムイニシャル")}>
          <Identity name="Backend Service" initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title={copy.tooltips}>
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{tr("Hover me", "여기에 올리기", "ここにホバー")}</Button>
            </TooltipTrigger>
            <TooltipContent>{tr("This is a tooltip", "이것은 툴팁입니다", "これはツールチップです")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>{tr("Settings", "설정", "設定")}</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title={copy.dialog}>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{tr("Open Dialog", "다이얼로그 열기", "ダイアログを開く")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{tr("Dialog Title", "다이얼로그 제목", "ダイアログタイトル")}</DialogTitle>
              <DialogDescription>
                {tr("This is a sample dialog showing the standard layout with header, content, and footer.", "헤더, 내용, 푸터가 있는 표준 레이아웃을 보여주는 샘플 다이얼로그입니다.", "ヘッダー・本文・フッターを持つ標準レイアウトを示すサンプルダイアログです。")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{tr("Name", "이름", "名前")}</Label>
                <Input placeholder={tr("Enter a name", "이름 입력", "名前を入力")} className="mt-1.5" />
              </div>
              <div>
                <Label>{tr("Description", "설명", "説明")}</Label>
                <Textarea placeholder={tr("Describe...", "설명 입력...", "説明を入力...")} className="mt-1.5" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline">{tr("Cancel", "취소", "キャンセル")}</Button>
              <Button>{tr("Save", "저장", "保存")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title={copy.emptyState}>
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message={tr("No items to show. Create your first one to get started.", "표시할 항목이 없습니다. 첫 항목을 만들어 시작하세요.", "表示する項目がありません。最初の項目を作成して始めましょう。")}
            action={tr("Create Item", "항목 만들기", "項目を作成")}
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title={copy.progressBars}>
        <div className="space-y-3">
          {[
            { label: tr("Under budget (40%)", "예산 이하 (40%)", "予算内 (40%)"), pct: 40, color: "bg-green-400" },
            { label: tr("Warning (75%)", "경고 (75%)", "警告 (75%)"), pct: 75, color: "bg-yellow-400" },
            { label: tr("Over budget (95%)", "예산 초과 (95%)", "予算超過 (95%)"), pct: 95, color: "bg-red-400" },
          ].map(({ label, pct, color }) => (
            <div key={label} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-xs font-mono">{pct}%</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width,background-color] duration-150 ${color}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  LOG VIEWER                                                   */}
      {/* ============================================================ */}
      <Section title={copy.logViewer}>
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">[12:00:01] INFO  {tr("Agent started successfully", "에이전트가 성공적으로 시작됨", "エージェントが正常に起動")}</div>
          <div className="text-foreground">[12:00:02] INFO  {tr("Processing task PAP-001", "작업 PAP-001 처리 중", "タスク PAP-001 を処理中")}</div>
          <div className="text-yellow-400">[12:00:05] WARN  {tr("Rate limit approaching (80%)", "요청 한도 임박 (80%)", "レート制限が近づいています (80%)")}</div>
          <div className="text-foreground">[12:00:08] INFO  {tr("Task PAP-001 completed", "작업 PAP-001 완료", "タスク PAP-001 完了")}</div>
          <div className="text-red-400">[12:00:12] ERROR {tr("Connection timeout to upstream service", "업스트림 서비스 연결 시간 초과", "アップストリームサービスへの接続タイムアウト")}</div>
          <div className="text-blue-300">[12:00:12] SYS   {tr("Retrying connection in 5s...", "5초 후 연결 재시도...", "5 秒後に再接続します...")}</div>
          <div className="text-foreground">[12:00:17] INFO  {tr("Reconnected successfully", "재연결 성공", "再接続に成功")}</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-cyan-400" />
            </span>
            <span className="text-cyan-400">{tr("Live", "라이브", "ライブ")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title={copy.propertyRowPattern}>
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{tr("Status", "상태", "状態")}</span>
            <StatusBadge status="active" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{tr("Priority", "우선순위", "優先度")}</span>
            <PriorityIcon priority="high" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{tr("Assignee", "담당자", "担当者")}</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">Agent Alpha</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{tr("Created", "생성됨", "作成日")}</span>
            <span className="text-xs">Jan 15, 2025</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title={copy.navigationPatterns}>
        <SubSection title={tr("Sidebar nav items", "사이드바 탐색 항목", "サイドバー項目")}>
          <div className="w-60 border border-border rounded-md p-3 space-y-0.5 bg-card">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              {tr("Dashboard", "대시보드", "ダッシュボード")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              {tr("Issues", "이슈", "Issue")}
              <span className="ml-auto text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                12
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              {tr("Agents", "에이전트", "エージェント")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              {tr("Projects", "프로젝트", "プロジェクト")}
            </div>
          </div>
        </SubSection>

        <SubSection title={tr("View toggle", "보기 전환", "表示切替")}>
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              {tr("List", "목록", "一覧")}
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              {tr("Org", "조직", "組織")}
            </button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title={copy.groupedListPattern}>
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">{tr("In Progress", "진행 중", "進行中")}</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            <EntityRow
              leading={<PriorityIcon priority="high" />}
              identifier="PAP-101"
              title={tr("Build agent heartbeat system", "에이전트 하트비트 시스템 구축", "エージェント heartbeat システム構築")}
              onClick={() => {}}
            />
            <EntityRow
              leading={<PriorityIcon priority="medium" />}
              identifier="PAP-102"
              title={tr("Add cost tracking dashboard", "비용 추적 대시보드 추가", "コスト追跡ダッシュボード追加")}
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title={copy.commentThreadPattern}>
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">{tr("Comments", "댓글", "コメント")} (2)</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{tr("Agent", "에이전트", "エージェント")}</span>
                <span className="text-xs text-muted-foreground">Jan 15, 2025</span>
              </div>
              <p className="text-sm">{tr("Started working on the authentication module. Will need API keys configured.", "인증 모듈 작업을 시작했습니다. API 키 설정이 필요합니다.", "認証モジュールの作業を開始しました。API キー設定が必要です。")}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{tr("Human", "사람", "人間")}</span>
                <span className="text-xs text-muted-foreground">Jan 16, 2025</span>
              </div>
              <p className="text-sm">{tr("API keys have been added to the vault. Please proceed.", "API 키를 vault에 추가했습니다. 계속 진행하세요.", "API キーを vault に追加しました。続行してください。")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder={tr("Leave a comment...", "댓글 남기기...", "コメントを残す...")} rows={3} />
            <Button size="sm">{tr("Comment", "댓글", "コメント")}</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title={copy.costTablePattern}>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{tr("Model", "모델", "モデル")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{tr("Tokens", "토큰", "トークン")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{tr("Cost", "비용", "コスト")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-sonnet-4-20250514</td>
                <td className="px-3 py-2 font-mono">1.2M</td>
                <td className="px-3 py-2 font-mono">$18.00</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-haiku-4-20250506</td>
                <td className="px-3 py-2 font-mono">500k</td>
                <td className="px-3 py-2 font-mono">$1.25</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-medium">{tr("Total", "합계", "合計")}</td>
                <td className="px-3 py-2 font-mono">1.7M</td>
                <td className="px-3 py-2 font-mono font-medium">$19.25</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SKELETONS                                                    */}
      {/* ============================================================ */}
      <Section title={copy.skeletons}>
        <SubSection title={tr("Individual", "개별", "個別")}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title={tr("Page Skeleton (list)", "페이지 스켈레톤 (목록)", "ページスケルトン (一覧)")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title={tr("Page Skeleton (detail)", "페이지 스켈레톤 (상세)", "ページスケルトン (詳細)")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title={copy.separator}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{tr("Horizontal", "가로", "水平")}</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">{tr("Left", "왼쪽", "左")}</span>
            <Separator orientation="vertical" />
            <span className="text-sm">{tr("Right", "오른쪽", "右")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      <Section title={copy.commonIcons}>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
          {[
            ["Inbox", Inbox],
            ["ListTodo", ListTodo],
            ["CircleDot", CircleDot],
            ["Hexagon", Hexagon],
            ["Target", Target],
            ["LayoutDashboard", LayoutDashboard],
            ["Bot", Bot],
            ["DollarSign", DollarSign],
            ["History", History],
            ["Search", Search],
            ["Plus", Plus],
            ["Trash2", Trash2],
            ["Settings", Settings],
            ["User", User],
            ["Mail", Mail],
            ["Upload", Upload],
            ["Zap", Zap],
          ].map(([name, Icon]) => {
            const LucideIcon = Icon as React.FC<{ className?: string }>;
            return (
              <div key={name as string} className="flex flex-col items-center gap-1.5 p-2">
                <LucideIcon className="h-4 w-4 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground font-mono">{name as string}</span>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  KEYBOARD SHORTCUTS                                           */}
      {/* ============================================================ */}
      <Section title={copy.keyboardShortcuts}>
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", "Open Command Palette"],
            ["C", "New Issue (outside inputs)"],
            ["[", "Toggle Sidebar"],
            ["]", "Toggle Properties Panel"],

            ["Cmd+Enter / Ctrl+Enter", "Submit markdown comment"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between px-4 py-2">
              <span className="text-muted-foreground">
                {desc === "Open Command Palette"
                  ? tr("Open Command Palette", "명령 팔레트 열기", "コマンドパレットを開く")
                  : desc === "New Issue (outside inputs)"
                    ? tr("New Issue (outside inputs)", "새 이슈 (입력창 밖)", "新しい issue (入力外)")
                    : desc === "Toggle Sidebar"
                      ? tr("Toggle Sidebar", "사이드바 전환", "サイドバー切替")
                      : desc === "Toggle Properties Panel"
                        ? tr("Toggle Properties Panel", "속성 패널 전환", "プロパティパネル切替")
                        : tr("Submit markdown comment", "마크다운 댓글 제출", "Markdown コメント送信")}
              </span>
              <kbd className="px-2 py-0.5 text-xs font-mono bg-muted rounded border border-border">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
