import { expect, it } from "vitest";
import { createPiProfileExtensionAdapter, PI_NOTICE_METHOD } from "./pi-extension-adapter.js";
import { validateAcpxRichEvent } from "./profile-extensions.js";
const context = { workspacePath: "/fixture", sessionId: "session", turnId: "turn" };
it("preserves bounded native notice severity, category and meaningful metadata without assistant output", async () => {
  const adapter = createPiProfileExtensionAdapter(context);
  for (const severity of ["info", "warning", "error"]) {
    const events = await adapter.notification(PI_NOTICE_METHOD, { sessionId: "session", category: "auto_retry_start", severity,
      summary: "Retry scheduled", details: { attempt: 2, maxAttempts: 3, delayMs: 200, errorMessage: "Authorization: Bearer fixture-private-token", secret: "DROP_ME" } });
    expect(events).toHaveLength(1); validateAcpxRichEvent(events[0]!);
    expect(events[0]).toMatchObject({ eventType: "provider.notice.recorded", payload: { severity, category: "pi.auto_retry_start", scope: "session" } });
    expect(events[0]!.payload.details).toContainEqual({ name: "attempt", value: "2" });
    expect(JSON.stringify(events)).not.toMatch(/DROP_ME|fixture-private-token/);
  }
});
it("rejects malformed/cross-session notices and cannot answer requests or emit final replies", async () => {
  const adapter = createPiProfileExtensionAdapter(context);
  for (const changed of [{ sessionId: "other" }, { category: "invented" }, { severity: "fatal" }, { summary: "x".repeat(4001) }]) {
    await expect(adapter.notification(PI_NOTICE_METHOD, { sessionId: "session", category: "compaction_end", severity: "info", summary: "Done", ...changed })).rejects.toThrow("contract");
  }
  await expect(adapter.request("exec", {})).rejects.toThrow("no qualified");
});
