// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunTranscriptUxLab } from "./RunTranscriptUxLab";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({ mode, density, streaming, limit }: { mode?: string; density?: string; streaming?: boolean; limit?: number }) => (
    <div>
      <div>run-transcript-view</div>
      <div>mode:{mode ?? "unknown"}</div>
      <div>density:{density ?? "unknown"}</div>
      <div>streaming:{String(streaming)}</div>
      {limit != null ? <div>limit:{limit}</div> : null}
    </div>
  ),
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <div>{status}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("RunTranscriptUxLab", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <RunTranscriptUxLab />
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

    throw new Error("Timed out waiting for RunTranscriptUxLab to settle");
  }

  it("renders localized shell copy and controls", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("运行转录夹具") === true);

    expect(container.textContent).toContain("UX 实验室");
    expect(container.textContent).toContain("运行转录夹具");
    expect(container.textContent).toContain("完整转录");
    expect(container.textContent).toContain("运行详情");
    expect(container.textContent).toContain("控制");
    expect(container.textContent).toContain("美化");
    expect(container.textContent).toContain("原始");
    expect(container.textContent).toContain("舒适");
    expect(container.textContent).toContain("紧凑");
    expect(container.textContent).toContain("显示已结束状态");
    expect(container.textContent).toContain("来源运行");
    expect(container.textContent).toContain("run-transcript-view");
    expect(container.textContent).toContain("mode:nice");
    expect(container.textContent).toContain("density:comfortable");
    expect(container.textContent).toContain("streaming:true");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized alternate surfaces and updates controls", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("事项小组件") === true);

    const liveSurfaceButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("事项小组件"));
    expect(liveSurfaceButton).toBeDefined();

    await act(async () => {
      liveSurfaceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("实时运行") === true);
    expect(container.textContent).toContain("用于事项详情页的实时运行小组件");
    expect(container.textContent).toContain("打开运行");
    expect(container.textContent).toContain("limit:12");

    const compactButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("紧凑"));
    expect(compactButton).toBeDefined();

    await act(async () => {
      compactButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("density:comfortable");

    const settledButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("显示已结束状态"));
    expect(settledButton).toBeDefined();

    await act(async () => {
      settledButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("显示流式状态") === true);
    expect(container.textContent).toContain("显示流式状态");
    expect(container.textContent).toContain("streaming:false");

    const dashboardButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("仪表盘卡片"));
    expect(dashboardButton).toBeDefined();

    await act(async () => {
      dashboardButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("正在实时运行") === true || container.textContent?.includes("2 分钟前已结束") === true);
    expect(container.textContent).toContain("仪表盘卡片");

    await act(async () => {
      root.unmount();
    });
  });
});
