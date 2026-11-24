// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "@/lib/router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AllowedToolsEmptyState } from "./AgentToolsTab";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { issuePrefix: "ORG" } }) }));

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("links the empty allowed-tools hint to the access profiles page", async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={["/ORG/agents/agent-1/tools"]}>
    <AllowedToolsEmptyState profilesHref="/apps/advanced/profiles" />
  </MemoryRouter>));

  const link = host.querySelector("a");
  expect(link?.textContent).toBe("Bind a tool profile");
  expect(link?.getAttribute("href")).toBe("/ORG/apps/advanced/profiles");
  expect(host.textContent).toBe("No tools are allowed for this agent. Bind a tool profile to grant access.");
});
