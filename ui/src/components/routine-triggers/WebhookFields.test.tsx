// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { CopyField } from "./WebhookFields";
import { isBlockedFromReplay } from "@/lib/analytics/replay-recording.test-utils";

afterEach(() => { document.body.innerHTML = ""; });

it("blocks the webhook URL and secret from session replay", () => {
  document.body.innerHTML = renderToStaticMarkup(<>
    <CopyField label="Webhook URL" value="https://paperclip.example.test/api/routine-triggers/hook_k4Zr9Qe1" />
    <CopyField label="Authentication key" value="whsec_Tq8vLm2Rz7Np" />
  </>);
  expect(isBlockedFromReplay("hook_k4Zr9Qe1", document.body)).toBe(true);
  expect(isBlockedFromReplay("whsec_Tq8vLm2Rz7Np", document.body)).toBe(true);
});
