import { describe, expect, it } from "vitest";
import {
  buildQuickProjectDraft,
  deriveProjectNameFromLinkUrl,
  looksLikeHttpLink,
} from "./project-quick-add";

describe("project quick add helpers", () => {
  it("classifies repo URLs as workspace-backed projects", () => {
    expect(buildQuickProjectDraft("https://github.com/paperclipai/paperclip.git")).toMatchObject({
      kind: "repo",
      name: "paperclip",
      workspace: {
        name: "paperclip",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        isPrimary: true,
      },
    });
    expect(buildQuickProjectDraft("https://git.example.com/paperclipai/paperclip")).toMatchObject({
      kind: "repo",
      name: "paperclip",
    });
  });

  it("classifies http links as quick-link-backed projects", () => {
    expect(buildQuickProjectDraft("http://roberts-mac-mini-2.tail3dddf6.ts.net:3100/projects/client-portal/issues")).toEqual({
      kind: "link",
      name: "Client Portal",
      quickLink: {
        url: "http://roberts-mac-mini-2.tail3dddf6.ts.net:3100/projects/client-portal/issues",
      },
    });
    expect(buildQuickProjectDraft("https://roberts-mac-mini-2.tail3dddf6.ts.net:3100/projects/client-portal/issues")).toMatchObject({
      kind: "link",
      name: "Client Portal",
      quickLink: {
        url: "https://roberts-mac-mini-2.tail3dddf6.ts.net:3100/projects/client-portal/issues",
      },
    });
  });

  it("keeps plain text as the project name", () => {
    expect(buildQuickProjectDraft("  Launch plan  ")).toEqual({
      kind: "name",
      name: "Launch plan",
    });
  });

  it("derives readable names from Tailscale-style links", () => {
    expect(deriveProjectNameFromLinkUrl("http://roberts-mac-mini-2.tail3dddf6.ts.net:3100/")).toBe(
      "Roberts Mac Mini 2",
    );
    expect(deriveProjectNameFromLinkUrl("https://example.com/workspaces/internal_tools")).toBe("Internal Tools");
  });

  it("accepts only http and https links for quick-link mode", () => {
    expect(looksLikeHttpLink("http://example.com")).toBe(true);
    expect(looksLikeHttpLink("https://example.com")).toBe(true);
    expect(looksLikeHttpLink("ssh://example.com/org/repo")).toBe(false);
    expect(looksLikeHttpLink("Just a project")).toBe(false);
  });
});
