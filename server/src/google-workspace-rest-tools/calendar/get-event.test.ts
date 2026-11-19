import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { TIMED_EVENT } from "./fixtures/calendar-rest.js";
import { getEvent } from "./get-event.js";

describe("get_event", () => {
  it("reads one event from the primary calendar by default", async () => {
    const { fetch, calls } = fakeGoogle(() => json(TIMED_EVENT));
    const result = await getEvent.call({ eventId: "evt0001timed" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[0]!.url.pathname).toBe("/calendar/v3/calendars/primary/events/evt0001timed");
    expect(result.structuredContent).toMatchObject({ id: "evt0001timed", summary: "Planning review" });
  });

  it("returns a tool error for a missing event and sends nothing for a bad ID", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 404 } }, 404));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    expect(await getEvent.call({ eventId: "gone1", calendarId: "team@example.test" }, http)).toEqual({
      isError: true, content: [{ type: "text", text: "Google could not find that item." }],
    });
    expect(calls[0]!.url.pathname).toBe("/calendar/v3/calendars/team%40example.test/events/gone1");
    expect((await getEvent.call({ eventId: "../x" }, http)).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
