// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { apiErrorFromResponse } from "@/api/api-error";
import { localizeUiError } from "@/lib/localized-ui-error";
import { SecretPopoverForm } from "./environment-variables-editor/CreateSecretPopover";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { DocumentFrameHeader } from "./DocumentFrameHeader";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: ReturnType<typeof createRoot>;
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ""; await i18n.changeLanguage("en"); });
it.each(["local", "api", "raw", "fallback"])("renders held %s secret errors while preserving draft, reveal state and operation count", async kind => {
  await i18n.changeLanguage("en"); const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const cause = kind === "local" ? localizeUiError(new Error("Select an organization to create secrets"), { key: "final-boundary:selectOrganization" })
    : kind === "api" ? apiErrorFromResponse(new Response("", { status: 403 }), { error: "forbidden" })
    : kind === "raw" ? new Error("Select an organization to create secrets") : undefined;
  const original = cause instanceof Error ? Object.getOwnPropertyDescriptors(cause) : cause;
  const submit = vi.fn().mockRejectedValue(cause);
  await act(async () => root.render(<Popover defaultOpen><PopoverTrigger>Open</PopoverTrigger><PopoverContent><SecretPopoverForm mode="create" initialName="raw_name" initialValue="RawValue" onSubmit={submit} onCancel={() => {}} /></PopoverContent></Popover>));
  const name = document.querySelector<HTMLInputElement>('input[placeholder="secret_name"]')!;
  const value = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  const show = document.querySelector<HTMLButtonElement>('button[aria-label="Show value"]')!;
  await act(async () => show.click()); expect(value.type).toBe("text");
  const create = [...document.querySelectorAll("button")].find(b => /Create.*bind/i.test(b.textContent ?? ""))!;
  await act(async () => create.click());
  const before = document.querySelector("p.text-destructive")?.textContent;
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  const expected = kind === "local" ? "请选择组织以创建密钥" : kind === "api" ? "你没有执行此操作的权限。" : kind === "raw" ? "Select an organization to create secrets" : "创建密钥失败";
  expect(document.querySelector("p.text-destructive")?.textContent).toBe(expected);
  expect(document.querySelector('input[placeholder="secret_name"]')).toBe(name); expect(name.value).toBe("raw_name"); expect(value.value).toBe("RawValue"); expect(value.type).toBe("text");
  expect(submit).toHaveBeenCalledExactlyOnceWith("raw_name", "RawValue"); expect(create.disabled).toBe(false);
  await act(async () => { await i18n.changeLanguage("en"); }); expect(document.querySelector("p.text-destructive")?.textContent).toBe(before);
  if (cause instanceof Error) expect(Object.getOwnPropertyDescriptors(cause)).toEqual(original);
});
it("renders dropdown revision zero by named interpolation without changing current/selection IDs or guarded states", async () => {
  await i18n.changeLanguage("en"); const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const select = vi.fn(); const onOpenChange = vi.fn();
  const menu = { open: true, onOpenChange, loading: false, revisions: [0, 2].map(n => ({ id: `raw-revision-${n}`, revisionNumber: n, createdAt: new Date(), actor: { kind: "system" as const, name: "System" } })), selectedRevisionId: "raw-revision-0", currentRevisionId: "raw-revision-2", displayedRevisionNumber: 0, historicalPreview: true, onSelectRevision: select };
  await act(async () => root.render(<DocumentFrameHeader documentKey="raw/key" folded={false} onToggleFolded={() => {}} revisionMenu={menu} />));
  const rows = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(rows()[0].textContent).toContain("rev 0"); const zero = rows()[0]; expect(zero.getAttribute("aria-checked")).toBe("true");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(rows()[0]).toBe(zero); expect(zero.textContent).toContain("修订版 0"); expect(zero.textContent).toContain("System");
  await act(async () => zero.click()); expect(select).toHaveBeenCalledExactlyOnceWith("raw-revision-0", false);
  await act(async () => { await i18n.changeLanguage("en"); }); expect(rows()[0].textContent).toContain("rev 0");
  await act(async () => root.render(<DocumentFrameHeader documentKey="raw/key" folded={false} onToggleFolded={() => {}} revisionMenu={{ ...menu, loading: true, revisions: [] }} />));
  expect(document.body.textContent).toContain("Loading revisions"); expect(rows()).toHaveLength(0);
  await act(async () => root.render(<DocumentFrameHeader documentKey="raw/key" folded={false} onToggleFolded={() => {}} revisionMenu={{ ...menu, revisions: [] }} />));
  expect(document.body.textContent).toContain("No revisions yet"); expect(menu.selectedRevisionId).toBe("raw-revision-0"); expect(menu.currentRevisionId).toBe("raw-revision-2");
});
