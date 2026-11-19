// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { AiConnectionPoolRunDetails } from "./AiConnectionPoolRunDetails";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

afterEach(() => { document.body.innerHTML = ""; });

it("masks the pinned pool account name in session replay", () => {
  document.body.innerHTML = renderToStaticMarkup(<AiConnectionPoolRunDetails context={{
    aiRouterSelection: { binding: { provider: "anthropic" }, runtimeConfig: { model: "claude-sonnet" }, notes: [] },
    aiConnection: { accountName: "Juniper Ops Pool Account", connectionId: "connection" },
  }} />);
  expect(replayLeaks("Juniper Ops Pool Account")).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("claude-sonnet")).toEqual({ rendered: true, recorded: true });
});
