// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionGrant } from "@paperclipai/shared";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import { aiSignInNotice } from "./model";

afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); });

it("tells the owner a week ahead that a subscription sign-in is ending", () => {
  const render = (signInEndsAt?: string) => renderToStaticMarkup(<AiConnectionAccountControls
    account={{ id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription",
      name: "Claude", ownership: "personal", status: "connected", ...(signInEndsAt ? { signInEndsAt } : {}) }}
    grant={{ id: "grant", capabilities: { canRevoke: true, canEditAudience: false } } as ConnectionGrant}
    currentUserId="user" onMakeDefault={vi.fn()} onReconnect={vi.fn()} onRevoke={vi.fn()} />);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 0, 10, 12, 0));
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000 + 3_600_000).toISOString();
  expect(render(inDays(3))).toContain("This sign-in ends in 3 days. Reconnect to keep runs working.");
  expect(render(inDays(0))).toContain("This sign-in ends today.");
  expect(render(inDays(-1))).toContain("This sign-in has ended. Reconnect to restore runs.");
  expect(render(inDays(20))).not.toContain("sign-in");
  expect(render()).not.toContain("sign-in");
});

it("counts the days to the sign-in end by calendar day", () => {
  const notice = (now: Date, end: Date) => aiSignInNotice({ signInEndsAt: end.toISOString() }, now.getTime());
  const lateEvening = new Date(2026, 0, 10, 23, 45);
  expect(notice(lateEvening, new Date(2026, 0, 10, 23, 55))).toContain("ends today");
  expect(notice(lateEvening, new Date(2026, 0, 11, 0, 15))).toContain("ends tomorrow");
  expect(notice(new Date(2026, 0, 10, 0, 5), new Date(2026, 0, 12, 23, 0))).toContain("ends in 2 days");
});
