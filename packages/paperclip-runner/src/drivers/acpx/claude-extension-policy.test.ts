import { describe, expect, it } from "vitest";
import { enforceClaudeExtensionPolicy } from "./claude-extension-policy.js";

describe("Claude marketplace admission", () => {
  it.each(["session/new", "session/load", "session/resume", "session/fork"])("blocks marketplace sources on %s while preserving tools and other policy", method => {
    const request = { method, params: { cwd: "/workspace", _meta: { kept: true, claudeCode: { options: {
      mcpServers: { paperclip: { type: "http", url: "http://localhost/tools" } },
      managedSettings: { strictKnownMarketplaces: [{ source: "github", repo: "other/market" }], disableAllHooks: true },
    } } } } };
    enforceClaudeExtensionPolicy("outbound",request);
    expect(request.params._meta.claudeCode.options.managedSettings).toEqual({strictKnownMarketplaces:[{source:"skills-dir"}],disableAllHooks:true});
    expect(request.params._meta.kept).toBe(true);
    expect(request.params._meta.claudeCode.options.mcpServers.paperclip.url).toBe("http://localhost/tools");
  });
  it.each(["inbound", "outbound"] as const)("leaves unrelated %s messages unchanged",direction=>{
    const request={method:"session/prompt",params:{prompt:[]}};const before=structuredClone(request);
    enforceClaudeExtensionPolicy(direction,request);expect(request).toEqual(before);
  });
});
