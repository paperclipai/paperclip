// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { MembershipAction } from "./MembershipAction";
import { ProviderFailureNotice } from "./ProviderFailureNotice";
import { StatusBadge, AgentStatusBadge, IssueStatusBadge } from "./StatusBadge";
import { ProjectAccessNotice } from "./ProjectAccessNotice";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(async () => { await i18n.changeLanguage("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await i18n.changeLanguage("en"); });
it("switches mounted membership copy with a full resource label and preserves dispatch/pending guards", async () => {
 const onJoin = vi.fn(), onLeave = vi.fn();
 const render = (pending = false) => act(() => root.render(<MembershipAction state="left" resourceName="Alpha / original" onJoin={onJoin} onLeave={onLeave} pending={pending} />));
 render(); const button = host.querySelector("button")!; expect(button.getAttribute("aria-label")).toBe("Join Alpha / original");
 await act(async () => { await i18n.changeLanguage("zh-CN"); });
 expect(button.textContent).toBe("加入"); expect(button.getAttribute("aria-label")).toBe("加入 Alpha / original");
 act(() => button.click()); expect(onJoin).toHaveBeenCalledOnce(); expect(onLeave).not.toHaveBeenCalled();
 render(true); expect(button.textContent).toBe("正在加入..."); act(() => button.click()); expect(onJoin).toHaveBeenCalledOnce();
 await act(async () => { await i18n.changeLanguage("en"); }); expect(button.textContent).toBe("Joining...");
});
it("localizes provider category/phase only while preserving diagnostics and unknown category/provider", async () => {
 const failure = { provider:"openai", category:"rate_limit", phase:"startup", message:"Rate limit reached: RAW", httpStatus:429, requestId:"req-raw", providerCode:"RATE_LIMIT" } as any;
 const snapshot = JSON.stringify(failure);
 act(() => root.render(<ProviderFailureNotice failure={failure} />));
 expect(host.textContent).toContain("Rate limit reached");
 await act(async () => { await i18n.changeLanguage("zh-CN"); });
 expect(host.textContent).toContain("OpenAI: 已达到速率限制"); expect(host.textContent).toContain("工作开始前失败"); expect(host.textContent).toContain(failure.message); expect(host.textContent).toContain("RATE_LIMIT"); expect(JSON.stringify(failure)).toBe(snapshot);
 act(() => root.render(<ProviderFailureNotice failure={{...failure, provider:"vendor-X",category:"constructor"} as any} />)); expect(host.textContent).toContain("vendor-X: constructor");
});
it("localizes known badge enums without changing aliases, glyphs, CSS or explicit/unknown labels", async () => {
 act(() => root.render(<><AgentStatusBadge status="active"/><IssueStatusBadge status="in_progress" displayStatus="monitoring"/><StatusBadge status="pending_approval"/><StatusBadge status="vendor_RAW"/><StatusBadge status="failed" label="Failed original"/></>));
 const icons = host.querySelector("svg")?.outerHTML; const styles = [...host.querySelectorAll("[style]")].map(x=>x.getAttribute("style"));
 await act(async () => { await i18n.changeLanguage("zh-CN"); });
 expect(host.textContent).toContain("空闲"); expect(host.textContent).toContain("监测中"); expect(host.textContent).toContain("等待审批"); expect(host.textContent).toContain("vendor_RAW"); expect(host.textContent).toContain("Failed original"); expect(host.querySelector("svg")?.outerHTML).toBe(icons); expect([...host.querySelectorAll("[style]")].map(x=>x.getAttribute("style"))).toEqual(styles);
});
it("renders complete project-access safety explanations and keeps saved-message actions", async () => {
 const onManage=vi.fn(), onRetry=vi.fn();
 act(() => root.render(<ProjectAccessNotice agentName="Agent Original" projectName="Project Original" ready={false} canRetry={false} canManage onManage={onManage} onRetry={onRetry} />));
 await act(async () => { await i18n.changeLanguage("zh-CN"); });
 expect(host.textContent).toContain("Agent Original 无法访问此项目"); expect(host.textContent).toContain("此任务需要访问智能体许可范围之外的项目 Project Original。智能体尚未开始运行。你的消息已保存。"); act(()=>host.querySelector("button")!.click()); expect(onManage).toHaveBeenCalledOnce(); expect(onRetry).not.toHaveBeenCalled();
});
