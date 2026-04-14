// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignGuide } from "./DesignGuide";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

vi.mock("@/components/ui/button", () => ({ Button: ({ children }: { children: unknown }) => <button>{children as never}</button> }));
vi.mock("@/components/ui/badge", () => ({ Badge: ({ children }: { children: unknown }) => <span>{children as never}</span> }));
vi.mock("@/components/ui/input", () => ({ Input: ({ placeholder, defaultValue, id }: { placeholder?: string; defaultValue?: string; id?: string }) => <input placeholder={placeholder} defaultValue={defaultValue} id={id} /> }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: ({ placeholder, defaultValue, id }: { placeholder?: string; defaultValue?: string; id?: string }) => <textarea placeholder={placeholder} defaultValue={defaultValue} id={id} /> }));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: () => <input type="checkbox" /> }));
vi.mock("@/components/ui/label", () => ({ Label: ({ children }: { children: unknown }) => <label>{children as never}</label> }));
vi.mock("@/components/ui/separator", () => ({ Separator: () => <hr /> }));
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => <div>skeleton</div> }));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsList: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsTrigger: ({ children }: { children: unknown }) => <button>{children as never}</button>,
  TabsContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CardHeader: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CardTitle: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CardDescription: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CardContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CardFooter: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogHeader: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogTitle: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogDescription: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogFooter: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TooltipTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TooltipContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SelectTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <div>{placeholder ?? "select-value"}</div>,
  SelectContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SelectItem: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DropdownMenuTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DropdownMenuContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DropdownMenuItem: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DropdownMenuSeparator: () => <div>separator</div>,
  DropdownMenuCheckboxItem: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DropdownMenuShortcut: ({ children }: { children: unknown }) => <span>{children as never}</span>,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  PopoverTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  PopoverContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SheetTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SheetContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SheetHeader: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SheetTitle: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SheetDescription: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SheetFooter: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CollapsibleTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CollapsibleContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: unknown }) => <div>{children as never}</div> }));
vi.mock("@/components/ui/command", () => ({
  Command: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CommandInput: () => <input />,
  CommandList: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CommandGroup: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CommandItem: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CommandEmpty: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  CommandSeparator: () => <div>separator</div>,
}));
vi.mock("@/components/ui/breadcrumb", () => ({
  Breadcrumb: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  BreadcrumbItem: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  BreadcrumbLink: ({ children }: { children: unknown }) => <a>{children as never}</a>,
  BreadcrumbList: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  BreadcrumbPage: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  BreadcrumbSeparator: () => <span>/</span>,
}));
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  AvatarFallback: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  AvatarGroup: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  AvatarGroupCount: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("@/components/StatusBadge", () => ({ StatusBadge: ({ status }: { status: string }) => <div>{status}</div> }));
vi.mock("@/components/StatusIcon", () => ({ StatusIcon: () => <div>status-icon</div> }));
vi.mock("@/components/PriorityIcon", () => ({ PriorityIcon: () => <div>priority-icon</div> }));
vi.mock("@/components/EntityRow", () => ({ EntityRow: () => <div>entity-row</div> }));
vi.mock("@/components/EmptyState", () => ({ EmptyState: () => <div>empty-state</div> }));
vi.mock("@/components/MetricCard", () => ({ MetricCard: () => <div>metric-card</div> }));
vi.mock("@/components/FilterBar", () => ({ FilterBar: () => <div>filter-bar</div> }));
vi.mock("@/components/InlineEditor", () => ({ InlineEditor: ({ value, placeholder }: { value: string; placeholder?: string }) => <div data-placeholder={placeholder}>{value}</div> }));
vi.mock("@/components/PageSkeleton", () => ({ PageSkeleton: () => <div>page-skeleton</div> }));
vi.mock("@/components/Identity", () => ({ Identity: ({ name }: { name: string }) => <div>{name}</div> }));
vi.mock("@/lib/status-colors", () => ({ agentStatusDot: {}, agentStatusDotDefault: "bg-muted" }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("DesignGuide", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
  });

  async function renderPage() {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <DesignGuide />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    return root;
  }

  async function waitFor(condition: () => boolean, attempts = 10) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (condition()) return;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    throw new Error("Timed out waiting for DesignGuide to settle");
  }

  it("renders localized page header and key section titles", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("设计指南") === true);

    expect(container.textContent).toContain("设计指南");
    expect(container.textContent).toContain("Paperclip 中使用的每一种组件、样式和模式。");
    expect(container.textContent).toContain("组件覆盖");
    expect(container.textContent).toContain("UI 原语");
    expect(container.textContent).toContain("应用组件");
    expect(container.textContent).toContain("颜色");
    expect(container.textContent).toContain("侧边栏");
    expect(container.textContent).toContain("图表");
    expect(container.textContent).toContain("排版");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized controls and editor copy", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("按钮") === true);

    expect(container.textContent).toContain("按钮");
    expect(container.textContent).toContain("新建事项");
    expect(container.textContent).toContain("删除");
    expect(container.textContent).toContain("已禁用描边");
    expect(container.textContent).toContain("表单元素");
    expect(container.textContent).toContain("复选框与标签");
    expect(container.textContent).toContain("已选项");
    expect(container.innerHTML).toContain("data-placeholder=\"添加描述...\"");
    expect(container.textContent).toContain("可编辑标题");
    expect(container.textContent).toContain("点击编辑这段文字");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized menus, panels, command palette, and shortcuts", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("下拉菜单") === true);

    expect(container.textContent).toContain("下拉菜单");
    expect(container.textContent).toContain("快捷操作");
    expect(container.textContent).toContain("标记为完成");
    expect(container.textContent).toContain("关注事项");
    expect(container.textContent).toContain("弹出卡片");
    expect(container.textContent).toContain("智能体心跳");
    expect(container.textContent).toContain("打开侧边面板");
    expect(container.textContent).toContain("事项属性");
    expect(container.textContent).toContain("命令（CMDK）");
    expect(container.textContent).toContain("打开命令面板");
    expect(container.textContent).toContain("键盘快捷键");
    expect(container.textContent).toContain("提交 Markdown 评论");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized cards, tabs, navigation, and empty states", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("卡片") === true);

    expect(container.textContent).toContain("卡片");
    expect(container.textContent).toContain("标准卡片");
    expect(container.textContent).toContain("标签页");
    expect(container.textContent).toContain("概览");
    expect(container.textContent).toContain("成本");
    expect(container.textContent).toContain("空状态");
    expect(container.textContent).toContain("导航模式");
    expect(container.textContent).toContain("侧边栏导航项");
    expect(container.textContent).toContain("智能体");
    expect(container.textContent).toContain("视图切换");
    expect(container.textContent).toContain("组织");
    expect(container.textContent).toContain("面包屑");
    expect(container.textContent).toContain("Paperclip 应用");
    expect(container.textContent).toContain("卡片标题");
    expect(container.textContent).toContain("对话框标题");
    expect(container.textContent).toContain("状态系统");
    expect(container.textContent).toContain("点击图标可切换状态");
    expect(container.textContent).toContain("滚动区域");
    expect(container.textContent).toContain("心跳运行 #1：已成功完成");
    expect(container.textContent).toContain("实体行");
    expect(container.textContent).toContain("头像");
    expect(container.textContent).toContain("身份标识");
    expect(container.textContent).toContain("日志查看器");
    expect(container.textContent).toContain("属性行模式");
    expect(container.textContent).toContain("分组列表（事项模式）");
    expect(container.textContent).toContain("评论线程模式");
    expect(container.textContent).toContain("成本表格模式");
    expect(container.textContent).toContain("骨架屏");
    expect(container.textContent).toContain("分隔线");
    expect(container.textContent).toContain("常用图标（Lucide）");

    await act(async () => {
      root.unmount();
    });
  });
});
