// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackOptInScopeGroup } from "@paperclipai/shared";
import { SlackScopeOptIns, type SlackOptInSetupMethod } from "./SlackScopeOptIns";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(props: {
  idPrefix: string;
  value?: SlackOptInScopeGroup[];
  installed?: SlackOptInScopeGroup[];
  setupMethod?: SlackOptInSetupMethod;
  disabled?: boolean;
  pending?: boolean;
  onChange?: (groups: SlackOptInScopeGroup[]) => void;
  onReconnect?: () => void;
}) {
  const onChange = props.onChange ?? vi.fn();
  await act(async () => root.render(
    <SlackScopeOptIns
      idPrefix={props.idPrefix}
      value={props.value ?? []}
      installed={props.installed}
      setupMethod={props.setupMethod}
      disabled={props.disabled}
      pending={props.pending}
      onChange={onChange}
      onReconnect={props.onReconnect}
    />,
  ));
  return onChange;
}

const prefix = (name: string) => `t-${name}`;
const checkboxes = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(`button[role="checkbox"]`)];
const statuses = (name: string) =>
  [...container.querySelectorAll<HTMLElement>("[data-slack-opt-in-status]")]
    .map((node) => node.getAttribute("data-slack-opt-in-status"));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);

describe("SlackScopeOptIns", () => {
  it("offers every opt-in group off by default with its description and scopes", async () => {
    await render({ idPrefix: prefix("off") });
    expect(container.textContent).toContain("Extra Slack permissions");
    const boxes = checkboxes("off");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.getAttribute("aria-checked") === "false")).toBe(true);
    expect(statuses("off")).toEqual(["off", "off"]);
    const helps = [...container.querySelectorAll('[id^="t-off-"][id$="-help"]')]
      .map((node) => node.textContent ?? "");
    expect(helps).toHaveLength(2);
    // Each group's real grant is spelled out, not just its label.
    expect(helps[0]).toContain("channels:manage");
    expect(helps[0]).toContain("groups:write");
    expect(helps[1]).toContain("files:write");
    expect(container.textContent).not.toContain("Proactive DMs");
  });

  it("states that enabling a group may need admin approval and states the default scope count without low-risk-only claim", async () => {
    await render({ idPrefix: prefix("review") });
    expect(container.textContent).toContain("29 scopes");
    expect(container.textContent).toContain("admin approval");
    expect(container.textContent).toContain("direct messages");
    expect(container.textContent).not.toContain("low-risk scopes, which your workspace can auto-approve");
  });

  it("adds a group on check and removes it on uncheck without touching the others", async () => {
    const onChange = await render({
      idPrefix: prefix("toggle"),
      value: ["file_upload"],
    });
    const boxes = checkboxes("toggle");
    expect(boxes[1]!.getAttribute("aria-checked")).toBe("true");
    await act(async () => boxes[0]!.click());
    expect(onChange).toHaveBeenLastCalledWith(["channel_management", "file_upload"]);
    // Controlled: re-render with the parent's next value, then uncheck.
    await render({
      idPrefix: prefix("toggle"),
      value: ["channel_management", "file_upload"],
      onChange,
    });
    await act(async () => checkboxes("toggle")[1]!.click());
    expect(onChange).toHaveBeenLastCalledWith(["channel_management"]);
  });

  it("shows requested, enabled, and still-installed states per group", async () => {
    await render({
      idPrefix: prefix("states"),
      value: ["channel_management"],
      installed: ["file_upload"],
    });
    expect(statuses("states")).toEqual(["requested", "installed"]);
    expect(container.textContent).toContain("Not active yet");
    expect(container.textContent).toContain("Still active because the app is installed");
  });

  it("does not prompt a reconnect for an untouched legacy install", async () => {
    const onReconnect = vi.fn();
    await render({
      idPrefix: prefix("legacy"),
      value: ["channel_management", "file_upload"],
      installed: ["channel_management", "file_upload"],
      onReconnect,
    });
    expect(statuses("legacy")).toEqual(["enabled", "enabled"]);
    expect(container.textContent).not.toContain("differs from what Slack granted");
    expect(button("Reinstall in Slack")).toBeUndefined();
  });

  it("describes each checkbox with its current dynamic status and scope help", async () => {
    for (const installed of [[], ["file_upload"]] as SlackOptInScopeGroup[][]) {
      await render({ idPrefix: prefix("accessible"), value: ["file_upload"], installed });
      const box = checkboxes("accessible")[1]!;
      const descriptions = box.getAttribute("aria-describedby")!.split(" ")
        .map(id => document.getElementById(id)?.textContent).join(" ");
      expect(descriptions).toContain("files:write");
      expect(descriptions).toContain(installed.length ? "Enabled" : "Requested — reinstall to activate");
    }
  });

  it("prompts a managed reinstall once the request differs from the install", async () => {
    const onReconnect = vi.fn();
    await render({
      idPrefix: prefix("managed"),
      value: ["file_upload"],
      installed: [],
      setupMethod: "managed",
      onReconnect,
    });
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain("differs from what Slack granted");
    expect(notice.textContent).toContain("Reinstall this agent's app");
    const action = button("Reinstall in Slack")!;
    expect(action).toBeDefined();
    await act(async () => action.click());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("prompts an own-app manifest update before the reinstall", async () => {
    const onReconnect = vi.fn();
    await render({
      idPrefix: prefix("own"),
      value: [],
      installed: ["file_upload"],
      setupMethod: "automatic",
      onReconnect,
    });
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain("Update the app configuration");
    const action = button("Update app and reinstall")!;
    await act(async () => action.click());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("does not show a reconnect prompt before the app is installed", async () => {
    await render({
      idPrefix: prefix("draft"),
      value: ["file_upload"],
      installed: undefined,
      setupMethod: "managed",
    });
    expect(statuses("draft")).toEqual(["off", "requested"]);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("disables every control and the reconnect action while a save is pending", async () => {
    await render({
      idPrefix: prefix("pending"),
      value: ["file_upload"],
      installed: [],
      setupMethod: "managed",
      pending: true,
      onReconnect: vi.fn(),
    });
    expect(checkboxes("pending").every((box) => box.disabled)).toBe(true);
    expect(button("Reinstall in Slack")!.disabled).toBe(true);
  });
});
