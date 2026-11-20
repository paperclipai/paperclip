// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpIcon } from "@paperclipai/shared";
import { TaskChatToolCard } from "./task-chat/TaskChatToolCard";
import {
  gatewayToolNameIn,
  ProviderToolIcon,
  ProviderToolIconsStaticProvider,
  providerToolIconLookup,
} from "./ProviderToolIcon";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Fallback(props: { className?: string; "data-testid"?: string }) {
  return <span data-fallback="true" data-testid={props["data-testid"]} className={props.className} />;
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

const PNG: McpIcon = { src: "https://cdn.example.com/meetings.png", mimeType: "image/png" };

describe("ProviderToolIcon", () => {
  it("renders the provider icon as an image without a referrer, never inline markup", async () => {
    const container = await render(<ProviderToolIcon icons={[PNG]} fallback={Fallback} testId="icon" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(PNG.src);
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("alt")).toBe("");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("[data-fallback]")).toBeNull();
  });

  it("keeps an inline SVG icon inside an img", async () => {
    const container = await render(<ProviderToolIcon icons={[{ src: "data:image/svg+xml;base64,PHN2Zy8+" }]} fallback={Fallback} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("falls back to the taxonomy icon when there is no icon, an unsafe one, or the image fails", async () => {
    expect((await render(<ProviderToolIcon icons={null} fallback={Fallback} />)).querySelector("[data-fallback]")).not.toBeNull();
    act(() => root?.unmount());
    // Re-checked at render time even if a stored value slipped past parsing.
    const unsafe = await render(<ProviderToolIcon icons={[{ src: "javascript:alert(1)" }]} fallback={Fallback} />);
    expect(unsafe.querySelector("img")).toBeNull();
    expect(unsafe.querySelector("[data-fallback]")).not.toBeNull();
    act(() => root?.unmount());
    const failing = await render(<ProviderToolIcon icons={[PNG]} fallback={Fallback} />);
    await act(async () => failing.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(failing.querySelector("img")).toBeNull();
    expect(failing.querySelector("[data-fallback]")).not.toBeNull();
  });
});

describe("provider icons in task chat tool rows", () => {
  const NATIVE = "app_mcp_circleback_1a2b3c4d_displaymeetings_0123456789ab";
  const entries = [{ gatewayToolName: "mcp.circleback-1a2b3c4d:displaymeetings", nativeToolName: NATIVE, icons: [PNG] }];

  it("finds the gateway tool name inside agent transcript names", () => {
    expect(gatewayToolNameIn("mcp__paperclip__mcp.circleback-1a2b3c4d:displaymeetings")).toBe("mcp.circleback-1a2b3c4d:displaymeetings");
    expect(gatewayToolNameIn("Bash")).toBeNull();
    const lookup = providerToolIconLookup(entries);
    expect(lookup("mcp.circleback-1a2b3c4d:displaymeetings")).toEqual([PNG]);
    // The gateway's duplicate-name suffix still finds the tool.
    expect(lookup("mcp.circleback-1a2b3c4d:displaymeetings-0f0f0f0f")).toEqual([PNG]);
    expect(lookup("mcp.other-99999999:displaymeetings")).toBeNull();
  });

  it("shows the provider icon on a matching row and the taxonomy icon elsewhere", async () => {
    const container = await render(
      <ProviderToolIconsStaticProvider entries={entries}>
        <TaskChatToolCard item={{ kind: "tool", id: "t1", name: "Display meetings", rawName: "mcp__paperclip__mcp.circleback-1a2b3c4d:displaymeetings", status: "completed" }} />
        <TaskChatToolCard item={{ kind: "tool", id: "t2", name: "Bash", rawName: "Bash", status: "completed" }} />
      </ProviderToolIconsStaticProvider>,
    );
    const icons = container.querySelectorAll("[data-testid='task-chat-tool-icon']");
    expect(icons).toHaveLength(2);
    expect(icons[0]!.tagName).toBe("IMG");
    expect(icons[0]!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(icons[1]!.tagName.toLowerCase()).toBe("svg");
  });

  it("indexes a company's icons once and finds each row's icon in constant work at realistic size", async () => {
    const ENTRIES = 500;
    const ROWS = 600;
    const big = Array.from({ length: ENTRIES }, (_, index) => ({
      gatewayToolName: `mcp.app${index % 25}-${(index % 25).toString(16).padStart(8, "0")}:tool-${index}`,
      icons: [PNG],
    }));
    const rawName = (index: number) => `mcp__paperclip__mcp.app${index % 25}-${(index % 25).toString(16).padStart(8, "0")}:tool-${index % ENTRIES}`;
    const set = vi.spyOn(Map.prototype, "set");
    const lookup = providerToolIconLookup(big);
    // The index is built once: one insert per entry.
    expect(set.mock.calls.length).toBe(ENTRIES);
    set.mockRestore();
    const get = vi.spyOn(Map.prototype, "get");
    let found = 0;
    for (let index = 0; index < ROWS; index += 1) if (lookup(rawName(index))) found += 1;
    // At most two index reads per row (exact name, then without a duplicate suffix); no scans.
    expect(get.mock.calls.length).toBeLessThanOrEqual(2 * ROWS);
    get.mockRestore();
    expect(found).toBe(ROWS);

    const container = await render(
      <ProviderToolIconsStaticProvider entries={big}>
        {Array.from({ length: 300 }, (_, index) => (
          <TaskChatToolCard key={index} item={{ kind: "tool", id: `t${index}`, name: `Tool ${index}`, rawName: rawName(index), status: "completed" }} />
        ))}
      </ProviderToolIconsStaticProvider>,
    );
    expect(container.querySelectorAll("img[data-provider-icon=true]")).toHaveLength(300);
  });

  it("re-picks the icon when the theme changes", async () => {
    const themed: McpIcon[] = [
      { src: "https://cdn.example.com/light.png", theme: "light" },
      { src: "https://cdn.example.com/dark.png", theme: "dark" },
    ];
    let setTheme!: (theme: "light" | "dark") => void;
    function Toggle() { setTheme = useTheme().setTheme; return null; }
    const container = await render(
      <ThemeProvider><Toggle /><ProviderToolIcon icons={themed} fallback={Fallback} /></ThemeProvider>,
    );
    await act(async () => setTheme("light"));
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://cdn.example.com/light.png");
    await act(async () => setTheme("dark"));
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://cdn.example.com/dark.png");
  });

  it("finds icons for native runner tool names", async () => {
    const lookup = providerToolIconLookup(entries);
    expect(lookup(NATIVE)).toEqual([PNG]);
    expect(lookup(`mcp__paperclip__${NATIVE}`)).toEqual([PNG]);
    expect(lookup("app_mcp_circleback_1a2b3c4d_displaymeetings_ffffffffffff")).toBeNull();
    const container = await render(
      <ProviderToolIconsStaticProvider entries={entries}>
        <TaskChatToolCard item={{ kind: "tool", id: "n1", name: "Display meetings", rawName: NATIVE, status: "completed" }} />
      </ProviderToolIconsStaticProvider>,
    );
    expect(container.querySelector("[data-testid='task-chat-tool-icon']")!.tagName).toBe("IMG");
  });
});
