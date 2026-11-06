import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AiConnectionPoolRunDetails } from "./AiConnectionPoolRunDetails";

const selection = {
  poolId: "pool", memberId: "codex-member", adapterType: "codex_local",
  binding: { provider: "openai", connectionId: "codex-account" },
  runtimeConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high" }, notes: [],
};

it("shows the persisted execution account and model rather than the configured agent provider", () => {
  const html = renderToStaticMarkup(<AiConnectionPoolRunDetails context={{ aiRouterSelection: selection, aiConnection: { accountName: "Backup OpenAI" } }} />);
  expect(html).toContain("Pool account · Backup OpenAI");
  expect(html).toContain("openai · codex_local · gpt-5.6-sol · high");
  expect(html).not.toContain("Waiting");
});

it("explains a persisted backup transition and quota wait", () => {
  const html = renderToStaticMarkup(<AiConnectionPoolRunDetails context={{ aiRouterSelection: selection,
    aiPoolFailover: { sourceRunId: "source", reason: "quota", waitingUntil: "2099-11-06T18:00:00Z" } }} />);
  expect(html).toContain("Backup pool account · codex-account");
  expect(html).toContain("Backup selected: usage limit reached.");
  expect(html).toContain("Waiting for account usage to reset");
  expect(html).toContain('dateTime="2099-11-06T18:00:00Z"');
});

it("does not infer backup or waiting state from a generic retry", () => {
  const html = renderToStaticMarkup(<AiConnectionPoolRunDetails context={{ aiRouterSelection: selection, previousRunId: "other", scheduledRetryAt: "2026-11-06T18:00:00Z" }} />);
  expect(html).not.toContain("Backup");
  expect(html).not.toContain("Waiting");
  expect(renderToStaticMarkup(<AiConnectionPoolRunDetails context={null} />)).toBe("");
});

it("does not label the successor with a previous account or an expired wait", () => {
  const html = renderToStaticMarkup(<AiConnectionPoolRunDetails context={{ aiRouterSelection: selection,
    aiConnection: { connectionId: "claude-account", accountName: "Previous Claude" },
    aiPoolFailover: { sourceRunId: "source", reason: "auth", waitingUntil: "2000-01-01T00:00:00Z" } }} />);
  expect(html).toContain("Backup pool account · codex-account");
  expect(html).toContain("account authentication failed");
  expect(html).not.toContain("Previous Claude");
  expect(html).not.toContain("Waiting");
});
