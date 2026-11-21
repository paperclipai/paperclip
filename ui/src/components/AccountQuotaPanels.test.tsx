// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { AccountQuotaPanels } from "./AccountQuotaPanels";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

afterEach(() => { document.body.innerHTML = ""; });

it("masks the subscription account label in session replay", () => {
  document.body.innerHTML = renderToStaticMarkup(<AccountQuotaPanels accounts={[{
    provider: "anthropic", accountKey: "key", accountLabel: "fenwick.oriel@example.test", ok: true,
    windows: [{ label: "Weekly limit", usedPercent: 40, valueLabel: null, resetsAt: null, detail: null }],
  }]} />);
  expect(replayLeaks("fenwick.oriel@example.test")).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("Weekly limit")).toEqual({ rendered: true, recorded: true });
});
