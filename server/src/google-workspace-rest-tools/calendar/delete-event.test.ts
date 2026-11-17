import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { deleteEvent, deleteEventRequest } from "./delete-event.js";
import { RECURRING_INSTANCE, RECURRING_SERIES, TIMED_EVENT } from "./fixtures/calendar-rest.js";

describe("delete_event request", () => {
  it.each([
    [undefined, "all"],
    ["NONE", "none"],
    ["EXTERNAL_ONLY", "externalOnly"],
  ] as const)("deletes one event; notificationLevel %s sends %s", (notificationLevel, expected) => {
    expect(deleteEventRequest({ eventId: "evt0003series_20261118T150000Z", calendarId: "team@example.test", notificationLevel })).toEqual({
      method: "DELETE",
      host: "www.googleapis.com",
      path: "/calendar/v3/calendars/team%40example.test/events/evt0003series_20261118T150000Z",
      query: { sendUpdates: expected },
    });
  });
});

describe("delete_event tool", () => {
  it("reads the event, deletes exactly that one occurrence, and returns it as cancelled", async () => {
    const { fetch, calls } = fakeGoogle(({ method }) => (method === "GET" ? json(RECURRING_INSTANCE) : new Response(null, { status: 204 })));
    const result = await deleteEvent.call({ eventId: RECURRING_INSTANCE.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /calendar/v3/calendars/primary/events/evt0003series_20261118T150000Z",
      "DELETE /calendar/v3/calendars/primary/events/evt0003series_20261118T150000Z",
    ]);
    expect(result.structuredContent).toMatchObject({ id: RECURRING_INSTANCE.id, status: "cancelled", recurringEventId: "evt0003series" });
  });

  it("deletes a single, non-recurring event", async () => {
    const { fetch, calls } = fakeGoogle(({ method }) => (method === "GET" ? json(TIMED_EVENT) : new Response(null, { status: 204 })));
    const result = await deleteEvent.call({ eventId: "evt0001timed" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(result.structuredContent).toMatchObject({ id: "evt0001timed", status: "cancelled" });
  });

  it("refuses a whole recurring series and sends no delete", async () => {
    const { fetch, calls } = fakeGoogle(() => json(RECURRING_SERIES));
    const result = await deleteEvent.call({ eventId: "evt0003series" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "This ID is a whole recurring series. This tool deletes single events or single occurrences only. Pass one occurrence's ID (from list_events). Nothing was deleted." }],
    });
  });

  it("deletes nothing when the event cannot be read", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 404 } }, 404));
    const result = await deleteEvent.call({ eventId: "missing1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("never retries the delete and warns that it may have happened", async () => {
    const { fetch, calls } = fakeGoogle(({ method }) => (method === "GET" ? json(TIMED_EVENT) : json({ error: { code: 503 } }, 503)));
    const result = await deleteEvent.call({ eventId: "evt0001timed" }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect((result.content[0] as { text: string }).text).toMatch(/may or may not have been made/);
  });

  it("accepts one event ID only", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const eventId of [["a", "b"], "a,b", "a b", "*"]) {
      expect((await deleteEvent.call({ eventId }, http)).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});
