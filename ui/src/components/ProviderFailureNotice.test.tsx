import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ProviderFailure } from "@paperclipai/shared";
import { ProviderFailureNotice } from "./ProviderFailureNotice";

const render = (failure: ProviderFailure) => renderToStaticMarkup(<ProviderFailureNotice failure={failure} />);

it("names the provider in plain words and shows no raw provider code or HTTP status", () => {
  // The live swarm quota refusal (2026-11-24) rendered as "antigravity: ... · HTTP 429 · RESOURCE_EXHAUSTED".
  const html = render({ schema: "paperclip.provider-failure.v1", provider: "antigravity", phase: "turn", category: "rate_limit",
    message: "Google refused the swarm: this account is out of quota for now. Try again later.", httpStatus: 429,
    providerCode: "RESOURCE_EXHAUSTED", retryability: "unknown" });
  expect(html).toContain("Google Antigravity: Rate limit reached");
  expect(html).toContain("Failed during work");
  expect(html).not.toMatch(/antigravity:|RESOURCE_EXHAUSTED|HTTP 429/);
});

it("keeps unknown provider ids readable", () => {
  const html = render({ schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup", category: "model_unavailable",
    message: "Model unavailable.", retryability: "requires_action" });
  expect(html).toContain("Claude: Model unavailable");
  expect(html).toContain("Failed before work started");
});
