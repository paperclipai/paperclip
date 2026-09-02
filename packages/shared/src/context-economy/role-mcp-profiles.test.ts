import { describe, expect, it } from "vitest";
import {
  CATEGORY_EAGER_MCP,
  narrowEagerMcpServers,
  ROLE_MCP_PROFILES,
} from "./role-mcp-profiles.js";

describe("role-mcp-profiles", () => {
  it("exposes a canonical profile for engineer and cto", () => {
    expect(ROLE_MCP_PROFILES.engineer.defaultEagerMcp).toEqual(["github"]);
    expect(ROLE_MCP_PROFILES.cto.maxEagerMcpTechnical).toBe(1);
  });

  it("regression: Engineer run with 3 unrelated MCPs keeps only Git", () => {
    const result = narrowEagerMcpServers({
      role: "engineer",
      taskCategory: "technical",
      candidates: [
        { name: "github" },
        { name: "cloudflare" },
        { name: "playwright" },
        { name: "storybook" },
      ],
    });
    expect(result.servers).toEqual([{ name: "github" }]);
    expect(result.droppedUnauthorized.sort()).toEqual([
      "cloudflare",
      "playwright",
      "storybook",
    ]);
    expect(result.droppedInactive).toEqual([]);
  });

  it("Engineer technical run never injects Cloudflare/Playwright/Storybook", () => {
    const result = narrowEagerMcpServers({
      role: "engineer",
      taskCategory: "technical",
      candidates: [
        { name: "github" },
        { name: "cloudflare" },
        { name: "playwright" },
        { name: "storybook" },
        { name: "shadcn" },
      ],
    });
    expect(result.servers.map((s) => s.name)).toEqual(["github"]);
  });

  it("Engineer UI task widens to UI tooling but still drops infra MCP", () => {
    const result = narrowEagerMcpServers({
      role: "engineer",
      taskCategory: "ui",
      candidates: [
        { name: "github" },
        { name: "shadcn" },
        { name: "storybook" },
        { name: "playwright" },
        { name: "cloudflare" },
      ],
    });
    expect(result.servers.map((s) => s.name).sort()).toEqual([
      "github",
      "playwright",
      "shadcn",
      "storybook",
    ]);
    expect(result.droppedUnauthorized).toEqual(["cloudflare"]);
  });

  it("CTO technical run defaults to at most one eager MCP (none without scope)", () => {
    const result = narrowEagerMcpServers({
      role: "cto",
      taskCategory: "technical",
      candidates: [{ name: "github" }, { name: "cloudflare" }],
    });
    expect(result.servers.map((s) => s.name)).toEqual([]);
    expect(result.droppedUnauthorized.sort()).toEqual(["cloudflare", "github"]);
  });

  it("CTO technical run allows exactly one scoped MCP", () => {
    const result = narrowEagerMcpServers({
      role: "cto",
      taskCategory: "technical",
      candidates: [{ name: "github" }, { name: "cloudflare" }],
      scopeRequiredMcp: ["cloudflare"],
    });
    expect(result.servers.map((s) => s.name)).toEqual(["cloudflare"]);
  });

  it("never counts disabled or archived bindings as active", () => {
    const result = narrowEagerMcpServers({
      role: "engineer",
      taskCategory: "technical",
      candidates: [
        { name: "github" },
        { name: "cloudflare", enabled: false },
        { name: "storybook", archived: true },
      ],
    });
    expect(result.servers.map((s) => s.name)).toEqual(["github"]);
    expect(result.droppedInactive.sort()).toEqual(["cloudflare", "storybook"]);
  });

  it("de-duplicates by name", () => {
    const result = narrowEagerMcpServers({
      role: "engineer",
      candidates: [{ name: "github" }, { name: "github" }],
    });
    expect(result.servers).toEqual([{ name: "github" }]);
  });

  it("keeps category map stable", () => {
    expect(CATEGORY_EAGER_MCP.ui).toContain("storybook");
    expect(CATEGORY_EAGER_MCP.infra).toContain("cloudflare");
  });
});
