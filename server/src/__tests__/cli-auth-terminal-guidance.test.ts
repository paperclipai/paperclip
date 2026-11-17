import { describe, expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";

// A chat agent asked to "connect my terminal to Paperclip as me" searched the
// API catalog, found the CLI auth operations without any statement of who starts
// the flow, and spent its whole turn reading source code to find the command.
describe("CLI terminal login guidance in the agent API catalog", () => {
  it.each([
    "connect my terminal to Paperclip as me",
    "terminal connect CLI login pair device link personal access",
    "cli-auth login code approve session token terminal",
  ])("search %j finds the person-run CLI login command", query => {
    const { results } = searchRunnerApi({ query, limit: 5 });
    const challenge = results.find(operation => operation.operationId === "POST /api/cli-auth/challenges");
    expect(challenge, query).toBeDefined();
    expect(challenge!.description).toContain("`npx paperclipai auth login --api-base <this Paperclip URL>`");
    expect(challenge!.description).toContain("never by an agent on their behalf");
    expect(challenge!.description).toContain("leave it as that placeholder instead of looking it up");
    expect(challenge!.description).toMatch(/never hand out an agent key, create or approve a challenge yourself, or ask for the person's password/);
  });

  it("tells agents that only the signed-in person can approve", () => {
    const { results } = searchRunnerApi({ query: "POST /api/cli-auth/challenges/{id}/approve" });
    expect(results[0]?.description).toContain("agent API keys receive 401");
    expect(results[0]?.description).toContain("`npx paperclipai auth login`");
  });
});
