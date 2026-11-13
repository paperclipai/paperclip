// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@playwright/test", () => ({ expect: vi.fn() }));
vi.mock("./api.js", () => ({ pollUntil: vi.fn() }));
vi.mock("./run-observations.js", () => ({ collectRunEvents: vi.fn() }));
vi.mock("./chat-catalog-domains/external-secret-scan.js", () => ({ scanReachableSecretOutputs: vi.fn(), privateScanJson: vi.fn(), bytesContainSecret: vi.fn(), sameSecretIdentity: vi.fn() }));
// Isolate the CSS/DOM regression from unrelated Node-only runtime setup.
vi.mock("./chat-flow.js", () => ({ sendChatMessage: vi.fn() }));
vi.mock("./chat-catalog-domains/identity-support.js", () => ({ identityWorker: vi.fn(), openStandingChat: vi.fn(), probeAgentPermission: vi.fn() }));
vi.mock("./chat-catalog-domains/external-support.js", () => ({ definition: () => ({}), observeExternal: vi.fn(), externalObservation: vi.fn(), checks: vi.fn(), root: vi.fn(), verifyRenderedReply: vi.fn() }));
import { secretProposalCardSelector } from "./chat-catalog-domains/external-secret-proposal.js";
afterEach(() => { document.body.innerHTML = ""; });
it("selects the actual expanded proposal card when the pending trigger has the same production interaction ID", () => {
  document.body.innerHTML = `<button id="interaction-owned" data-testid="task-chat-pending-request" aria-label="Open request: Confirm secret binding">Confirm secret binding</button>
    <div id="interaction-owned" data-testid="task-chat-interaction"><p>Deployment publishing key</p><p>Morgan</p><p>env.PUBLISHING_API_KEY</p></div>
    <div id="interaction-other" data-testid="task-chat-interaction"><p>Other request</p></div>`;
  expect(document.querySelectorAll('[id="interaction-owned"]')).toHaveLength(2);
  const selected = document.querySelectorAll(secretProposalCardSelector("owned"));
  expect(selected).toHaveLength(1); expect(selected[0]?.tagName).toBe("DIV");
  for (const fact of ["Deployment publishing key", "Morgan", "env.PUBLISHING_API_KEY"]) expect(selected[0]?.textContent).toContain(fact);
  expect(document.querySelectorAll(secretProposalCardSelector("missing"))).toHaveLength(0);
});
it("a trigger, unrelated card or completed receipt cannot stand in for the bound proposal card", () => {
  document.body.innerHTML = `<button id="interaction-owned" data-testid="task-chat-pending-request">Confirm secret binding</button>
    <div id="interaction-foreign" data-testid="task-chat-interaction">Deployment publishing key Morgan env.PUBLISHING_API_KEY</div>
    <div id="interaction-owned" data-testid="task-chat-interaction-receipt">Approved</div>`;
  expect(document.querySelectorAll(secretProposalCardSelector("owned"))).toHaveLength(0);
});
