import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { eventList, RECURRING_SERIES } from "./fixtures/calendar-rest.js";
import { searchEvents, searchEventsRequest } from "./search-events.js";

describe("search_events", () => {
  it("searches the primary calendar by keyword, one entry per series", () => {
    expect(searchEventsRequest({ query: "budget review" })).toEqual({
      method: "GET",
      host: "www.googleapis.com",
      path: "/calendar/v3/calendars/primary/events",
      query: { q: "budget review", singleEvents: false, maxResults: 25, pageToken: undefined, eventTypes: ["default", "outOfOffice", "focusTime", "fromGmail"] },
    });
    expect(searchEventsRequest({ query: "x", pageSize: 999, pageToken: "n" }).query).toMatchObject({ maxResults: 250, pageToken: "n" });
  });

  it("returns events and the next page token", async () => {
    const { fetch } = fakeGoogle(() => json(eventList([RECURRING_SERIES], { nextPageToken: "n2" })));
    const result = await searchEvents.call({ query: "standup" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual({ events: [expect.objectContaining({ id: "evt0003series", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"] })], nextPageToken: "n2" });
  });

  it("requires a non-empty query", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    expect((await searchEvents.call({ query: "  " }, createGoogleHttp({ accessToken: "t", fetch }))).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
