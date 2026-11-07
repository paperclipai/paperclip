import { expect, it } from "vitest";
import { isDisabledChatBoundaryScreenshotRoute, isPublicRunnerScreenshotRoute } from "./screenshot-policy.js";
const target = { scenarioId: "agent-chat.chat-disabled", origin: "http://127.0.0.1:3100", companyId: "owned-company", agentCompanyId: "owned-company",
  issuePrefix: "RUN", agentId: "morgan", authenticatedPersonId: "real-fixture-person", agentChatEnabled: false };
it("permits only the exact independently owned disabled-chat boundary route without manufacturing a task", () => {
  expect(isDisabledChatBoundaryScreenshotRoute(`${target.origin}/RUN/chats/morgan`, target)).toBe(true);
  expect(isPublicRunnerScreenshotRoute(`${target.origin}/RUN/chats/morgan`, { chatAgentId: "morgan", issuePrefix: "RUN", issueId: undefined, issueIdentifier: undefined })).toBe(false);
});
it("rejects wrong boundary, person, company, agent, prefix, port, host, query and foreign paths", () => {
  for (const wrong of [{ agentChatEnabled: true }, { scenarioId: "agent-chat.reopen-conversation" }, { authenticatedPersonId: "local-board" }, { authenticatedPersonId: "" },
    { agentCompanyId: "foreign" }, { companyId: "" }, { agentId: "other" }, { issuePrefix: "FOREIGN" }])
    expect(isDisabledChatBoundaryScreenshotRoute(`${target.origin}/RUN/chats/morgan`, { ...target, ...wrong })).toBe(false);
  for (const wrong of ["http://127.0.0.1:3200/RUN/chats/morgan", "https://example.test/RUN/chats/morgan", `${target.origin}/RUN/chats/other`,
    `${target.origin}/RUN/chats/morgan?private=1`, `${target.origin}/RUN/chats/morgan#private`, `${target.origin}/RUN/agents/morgan`, `${target.origin}/RUN/dashboard`])
    expect(isDisabledChatBoundaryScreenshotRoute(wrong, target)).toBe(false);
});
