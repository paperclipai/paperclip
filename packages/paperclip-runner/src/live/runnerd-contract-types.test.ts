import { describe, expectTypeOf, it } from "vitest";
import type { HarnessSession } from "../contracts/harness-driver.js";
import type { CodexHarnessSession } from "../drivers/codex/codex-harness-session.js";
import type { RetainedRunnerdCleanupProof, RetainedRunnerdMaintenanceInput } from "./runnerd-codex-transport.js";

// The Runner test typecheck checks these assertions. Vitest only runs them.
describe("Runner contract types", () => {
  it("accepts only the runner backend kind for retained cleanup", () => {
    // The quarantine domain uses the descriptor kind, which is "runner" for every
    // production backend. Another kind would release nothing.
    expectTypeOf<RetainedRunnerdMaintenanceInput["backend"]["kind"]>().toEqualTypeOf<"runner">();
    expectTypeOf<RetainedRunnerdCleanupProof["backend"]["kind"]>().toEqualTypeOf<"runner">();

    // @ts-expect-error: a backend kind other than "runner" is not allowed.
    const remote: RetainedRunnerdMaintenanceInput["backend"] = { kind: "remote", name: "codex_app_server" };
    void remote;
  });

  it("matches the HarnessSession close contract in the Codex session", () => {
    expectTypeOf<Parameters<CodexHarnessSession["close"]>>().toEqualTypeOf<Parameters<HarnessSession["close"]>>();
  });
});
