// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { McpIcon } from "@paperclipai/shared";
import { TaskChatToolCard } from "./task-chat/TaskChatToolCard";
import {
  gatewayToolNameIn,
  ProviderToolIcon,
  ProviderToolIconsStaticProvider,
  providerToolIconLookup,
} from "./ProviderToolIcon";

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
  const entries = [{ gatewayToolName: "mcp.circleback-1a2b3c4d:displaymeetings", icons: [PNG] }];

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
});
