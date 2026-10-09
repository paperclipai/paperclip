// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";

const getIssue = vi.hoisted(() => vi.fn());
vi.mock("../api/issues", () => ({ issuesApi: { get: getIssue } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props} />,
  useCaseHref: () => () => "",
}));
vi.mock("../context/CompanyContext", () => ({ useOptionalCompany: () => null }));

afterEach(() => vi.clearAllMocks());

it.each(["pointerover", "focusin"])("fetches mentioned task details only on %s", async (event) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  getIssue.mockResolvedValue({ id: "task-72", identifier: "PAP-72", title: "Mentioned task", status: "done" });
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}><ThemeProvider>
        <MarkdownBody>{"See PAP-72 and PAP-73 for background."}</MarkdownBody>
      </ThemeProvider></QueryClientProvider>,
    ));
    expect(getIssue).not.toHaveBeenCalled();
    const link = container.querySelector<HTMLAnchorElement>('a[href="/issues/PAP-72"]')!;
    expect(link).not.toBeNull();
    await act(async () => {
      link.dispatchEvent(new MouseEvent(event, { bubbles: true }));
    });
    expect(getIssue).toHaveBeenCalledExactlyOnceWith("PAP-72");
  } finally {
    act(() => root.unmount());
    client.clear();
    container.remove();
  }
});
