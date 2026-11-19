// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionGrant } from "@paperclipai/shared";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

afterEach(() => { document.body.innerHTML = ""; });

it("masks the account label line in session replay", () => {
  document.body.innerHTML = renderToStaticMarkup(<AiConnectionAccountControls
    account={{ id: "connection", grantId: "grant", companyId: "company", provider: "openai", method: "subscription",
      name: "Team ChatGPT", accountLabel: "tamsin.vale@example.test", ownership: "shared", status: "connected" }}
    grant={{ id: "grant", capabilities: { canRevoke: true, canEditAudience: false } } as ConnectionGrant}
    currentUserId="user" onMakeDefault={vi.fn()} onReconnect={vi.fn()} onRevoke={vi.fn()} />);
  expect(replayLeaks("tamsin.vale@example.test")).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("Reconnect")).toEqual({ rendered: true, recorded: true });
});
