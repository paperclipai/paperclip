// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../context/ThemeContext";
import { RunInvocationCard } from "./HeartbeatRunDetailPanel";

describe("RunInvocationCard", () => {
  it("keeps verbose invocation details collapsed by default", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{
            adapterType: "claude_local",
            cwd: "/tmp/workspace",
            command: "claude",
            commandArgs: ["--dangerously-skip-permissions"],
            commandNotes: ["Prompt is piped to claude via stdin."],
            prompt: "very long prompt body",
            context: { triggeredBy: "board" },
            env: { ANTHROPIC_API_KEY: "***REDACTED***" },
          }}
          censorUsernameInLogs={false}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("调用");
    expect(html).toContain("适配器:");
    expect(html).toContain("工作目录:");
    expect(html).toContain("详情");
    expect(html).not.toContain("命令:");
    expect(html).not.toContain("Prompt is piped to claude via stdin.");
    expect(html).not.toContain("very long prompt body");
    expect(html).not.toContain("ANTHROPIC_API_KEY");
    expect(html).not.toContain("triggeredBy");
  });
});
