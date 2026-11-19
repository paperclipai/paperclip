// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { AiConnectionIdentity } from "./AiConnectionIdentity";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

afterEach(() => { document.body.innerHTML = ""; });

it("masks the connection name and account label in session replay", () => {
  document.body.innerHTML = renderToStaticMarkup(<AiConnectionIdentity connection={{
    id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription",
    name: "Zephyr Labs Claude", accountLabel: "quill.marten@example.test", ownership: "shared", status: "connected",
  }} />);
  expect(replayLeaks("Zephyr Labs Claude")).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("quill.marten@example.test")).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("Company shared")).toEqual({ rendered: true, recorded: true });
});
