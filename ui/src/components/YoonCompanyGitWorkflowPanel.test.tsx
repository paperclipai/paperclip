// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YoonCompanyGitWorkflowPanel } from "./YoonCompanyGitWorkflowPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("YoonCompanyGitWorkflowPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("explains local, fork, upstream, PR, and merge boundaries without git mutations", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<YoonCompanyGitWorkflowPanel />);
    });

    expect(container.textContent).toContain("로컬/GitHub/PR 위치 안내");
    expect(container.textContent).toContain("읽기 전용 안내");
    expect(container.textContent).toContain("C:\\yooncompany\\external\\paperclip");
    expect(container.textContent).toContain("hy60002/paperclip");
    expect(container.textContent).toContain("paperclipai/paperclip");
    expect(container.textContent).toContain("codex/작은-단위-작업명");
    expect(container.textContent).toContain("CI 통과 + 원본 정책/권한 필요");
    expect(container.textContent).toContain("승인 id는 작업 이슈와 PR 증거 댓글에 남김");
    expect(container.textContent).toContain("admin merge 금지");
    expect(container.textContent).toContain("원본 정책과 권한이 허용할 때만 merge");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('a[href="https://github.com/hy60002/paperclip"]')?.textContent).toContain("포크 열기");
    expect(container.querySelector('a[href="https://github.com/paperclipai/paperclip/pulls"]')?.textContent).toContain("원본 PR 보기");

    await act(async () => {
      root.unmount();
    });
  });
});
