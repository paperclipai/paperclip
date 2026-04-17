// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueChatUxLab } from "./IssueChatUxLab";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

vi.mock("../components/IssueChatThread", () => ({
  IssueChatThread: ({
    showComposer,
    composerDisabledReason,
    draftKey,
  }: {
    showComposer?: boolean;
    composerDisabledReason?: string;
    draftKey?: string;
  }) => (
    <div>
      <div>issue-chat-thread:{draftKey ?? "unknown"}</div>
      <div>composer:{showComposer === false ? "hidden" : "visible"}</div>
      {composerDisabledReason ? <div>{composerDisabledReason}</div> : null}
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueChatUxLab", () => {
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
          <IssueChatUxLab />
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

    throw new Error("Timed out waiting for IssueChatUxLab to settle");
  }

  it("renders localized shell copy and toggles composer label", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("事项聊天审阅界面") === true);

    expect(container.textContent).toContain("聊天 UX 实验室");
    expect(container.textContent).toContain("事项聊天审阅界面");
    expect(container.textContent).toContain("覆盖状态");
    expect(container.textContent).toContain("运行中的助手回复，包含流式文本、推理、工具卡片和后台状态说明");
    expect(container.textContent).toContain("轮换推理文本");
    expect(container.textContent).toContain("Working / Worked 标题动词");
    expect(container.textContent).toContain("实时执行线程");
    expect(container.textContent).toContain("这个页面该检查什么");
    expect(container.textContent).toContain("在主预览中隐藏输入框");
    expect(container.textContent).toContain("跳转到实时执行预览");
    expect(container.textContent).toContain("待发送消息气泡");
    expect(container.textContent).toContain("持久评论与反馈");
    expect(container.textContent).toContain("空状态与禁用输入框");
    expect(container.textContent).toContain("此工作区已关闭，因此在重新打开事项之前无法继续发送新的聊天回复。");
    expect(container.textContent).toContain("issue-chat-thread:issue-chat-ux-lab-primary");
    expect(container.textContent).toContain("issue-chat-thread:issue-chat-ux-lab-submitting");
    expect(container.textContent).toContain("issue-chat-thread:issue-chat-ux-lab-review");
    expect(container.textContent).toContain("issue-chat-thread:issue-chat-ux-lab-empty");
    expect(container.textContent).toContain("composer:visible");

    const composerToggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("在主预览中隐藏输入框"),
    );

    expect(composerToggle).toBeTruthy();

    await act(async () => {
      composerToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("在主预览中显示输入框") === true);
    expect(container.textContent).toContain("在主预览中显示输入框");
    expect(container.textContent).toContain("composer:hidden");

    await act(async () => {
      root.unmount();
    });
  });
});
