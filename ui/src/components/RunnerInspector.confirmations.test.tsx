// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { RunnerInspector } from "./RunnerInspector";

const api = vi.hoisted(() => ({ access: vi.fn(), events: vi.fn(), trace: vi.fn(), reveal: vi.fn(), download: vi.fn(), delete: vi.fn() }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: api.access } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { events: api.events, providerTrace: api.trace, revealProviderTraceFrame: api.reveal, downloadProviderTrace: api.download, deleteProviderTrace: api.delete } }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  SelectValue: () => null,
}));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const actions = [
  { api: "reveal", label: "revealExactFrame_2a05878d", en: "This exact provider frame may contain prompts, tool arguments, secrets, or reasoning. Reveal it now?", zh: "此提供方的原始数据帧可能包含提示词、工具参数、密钥或推理内容。现在显示吗？" },
  { api: "download", label: "downloadExactTrace_8ce74eaf", en: "Download the exact raw trace? It may contain sensitive prompts, tool arguments, and provider-only fields.", zh: "要下载完整的原始跟踪记录吗？其中可能包含敏感提示词、工具参数和仅提供方使用的字段。" },
  { api: "delete", label: "deleteTrace_b0a07853", en: "Delete this raw trace immediately? This cannot be undone.", zh: "要立即删除此原始跟踪记录吗？此操作无法撤销。" },
] as const;
async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
}
function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === i18n.t(`task-components:${label}`));
}
async function render() {
  await act(async () => root.render(<RunnerInspector runId="run-1" run={{ status: "succeeded", resultJson: null }} open onOpenChange={vi.fn()} />));
  await flush();
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  api.access.mockResolvedValue({ source: "local_implicit", isInstanceAdmin: false });
  api.events.mockResolvedValue([]);
  api.trace.mockResolvedValue({ trace: { id: "trace-1", runId: "run-1", status: "complete", frameCount: 1, byteCount: 31 },
    entries: [{ kind: "frame", frameId: 1, direction: "provider_to_client", byteLength: 31, parsed: { method: "item/completed" }, withheldPaths: ["secret"] }] });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); await i18n.changeLanguage("en");
});
describe("raw-trace informed confirmations", () => {
  it.each(actions)("switches mounted $api confirmation and makes no sensitive API call on cancel", async action => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render();
    expect(button(action.label)).toBeDefined();
    await act(async () => button(action.label)!.click());
    expect(confirm).toHaveBeenLastCalledWith(action.en);
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    await act(async () => button(action.label)!.click());
    expect(confirm).toHaveBeenLastCalledWith(action.zh);
    expect(api.reveal).not.toHaveBeenCalled(); expect(api.download).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
  });
  it.each(["en", "zh-CN"])("retains all permission guards for a non-admin (%s)", async locale => {
    await i18n.changeLanguage(locale);
    api.access.mockResolvedValue({ source: "membership", isInstanceAdmin: false });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    for (const action of actions) expect(button(action.label)).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled(); expect(api.trace).not.toHaveBeenCalled();
    expect(api.reveal).not.toHaveBeenCalled(); expect(api.download).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
  });
  it.each(actions)("still dispatches the original $api API only after acceptance", async action => {
    await i18n.changeLanguage("zh-CN");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    // Keep the operation pending: no fabricated blob/frame or navigation is needed to prove dispatch.
    api[action.api].mockReturnValue(new Promise(() => {}));
    await render();
    await act(async () => button(action.label)!.click());
    if (action.api === "reveal") expect(api.reveal).toHaveBeenCalledExactlyOnceWith("run-1", 1);
    else expect(api[action.api]).toHaveBeenCalledExactlyOnceWith("run-1");
    for (const other of actions) if (other.api !== action.api) expect(api[other.api]).not.toHaveBeenCalled();
  });
});
