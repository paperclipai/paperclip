import { describe, expect, it } from "vitest";
import { redactToolDetailText, sidecarToolDetail } from "./acpx-tool-detail-redaction.js";

const env = {} as NodeJS.ProcessEnv;

describe("tool detail redaction at the sidecar boundary", () => {
  it("removes an authorization header with its scheme and credential", () => {
    const text = redactToolDetailText("curl -H 'Authorization: Bearer top-secret-value' https://example.test/", env);
    expect(text).not.toContain("top-secret-value");
    expect(text).toContain("https://example.test/");
  });

  it("removes bare bearer tokens and key=value secrets", () => {
    for (const raw of [
      "export TOKEN=top-secret-value",
      "curl https://example.test?token=top-secret-value&x=1",
      "login --password top=x password=top-secret-value",
      "use bearer top-secret-value now",
      "api_key: top-secret-value",
    ]) {
      expect(redactToolDetailText(raw, env)).not.toContain("top-secret-value");
    }
  });

  it("removes the run's observability header values", () => {
    expect(redactToolDetailText("echo hunter2-header", { OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=hunter2-header" } as NodeJS.ProcessEnv))
      .not.toContain("hunter2-header");
  });

  it("re-bounds each field after redaction so runner-core accepts the event", () => {
    const subject = `${"echo key=a ".repeat(400)}`.slice(0, 4_000);
    const { toolDetail } = sidecarToolDetail({
      toolName: "B".repeat(300),
      subject,
      description: "ok",
      exitCode: 2,
      durationMs: -5,
      unknown: "dropped",
    }, env);
    expect(Array.from(toolDetail!.subject as string).length).toBeLessThanOrEqual(4_000);
    expect(Array.from(toolDetail!.toolName as string).length).toBe(240);
    expect(toolDetail).toMatchObject({ description: "ok", exitCode: 2 });
    expect(toolDetail).not.toHaveProperty("durationMs");
    expect(toolDetail).not.toHaveProperty("unknown");
    expect(sidecarToolDetail(null, env)).toEqual({});
  });
});
