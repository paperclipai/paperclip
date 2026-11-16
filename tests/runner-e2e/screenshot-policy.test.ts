import { expect, it } from "vitest";
import { isConferenceRoomOffBoundaryScreenshotRoute, isPublicRunnerScreenshotRoute } from "./screenshot-policy.js";
const target = { scenarioId: "agent-chat.chat-disabled", origin: "http://127.0.0.1:3100", companyId: "owned-company", agentCompanyId: "owned-company",
  issuePrefix: "RUN", agentId: "morgan", authenticatedPersonId: "real-fixture-person", conferenceRoomEnabled: false };
it("permits only the exact independently owned Conference Room-off landing route without manufacturing a task", () => {
  expect(isConferenceRoomOffBoundaryScreenshotRoute(`${target.origin}/RUN/dashboard`, target)).toBe(true);
  expect(isPublicRunnerScreenshotRoute(`${target.origin}/RUN/chats/morgan`, { chatAgentId: "morgan", issuePrefix: "RUN", issueId: undefined, issueIdentifier: undefined })).toBe(false);
});
it("rejects wrong boundary, person, company, agent, prefix, port, host, query and foreign paths", () => {
  for (const wrong of [{ conferenceRoomEnabled: true }, { scenarioId: "agent-chat.reopen-conversation" }, { authenticatedPersonId: "local-board" }, { authenticatedPersonId: "" },
    { agentCompanyId: "foreign" }, { companyId: "" }, { agentId: "" }, { issuePrefix: "FOREIGN" }])
    expect(isConferenceRoomOffBoundaryScreenshotRoute(`${target.origin}/RUN/dashboard`, { ...target, ...wrong })).toBe(false);
  for (const wrong of ["http://127.0.0.1:3200/RUN/dashboard", "https://example.test/RUN/dashboard", `${target.origin}/OTHER/dashboard`,
    `${target.origin}/RUN/dashboard?private=1`, `${target.origin}/RUN/dashboard#private`, `${target.origin}/RUN/agents/morgan`, `${target.origin}/RUN/board-chat`, `${target.origin}/RUN/chats/morgan`])
    expect(isConferenceRoomOffBoundaryScreenshotRoute(wrong, target)).toBe(false);
});
