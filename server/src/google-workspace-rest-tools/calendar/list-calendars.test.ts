import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { probeCalendar } from "./index.js";
import { calendarProbeRequest, listCalendars, listCalendarsRequest, listCalendarsResult } from "./list-calendars.js";

describe("list_calendars", () => {
  it.each([
    [{}, 100],
    [{ pageSize: 10 }, 10],
    [{ pageSize: 1000 }, 250],
  ])("asks calendarList.list for %j", (input, maxResults) => {
    expect(listCalendarsRequest(input)).toEqual({
      method: "GET", host: "www.googleapis.com", path: "/calendar/v3/users/me/calendarList", query: { maxResults, pageToken: undefined },
    });
  });

  it("maps entries, preferring the user's own name for a calendar", () => {
    expect(listCalendarsResult({
      items: [
        { id: "avery@example.test", summary: "avery@example.test", timeZone: "America/New_York" },
        { id: "family@group.calendar.google.com", summary: "Shared", summaryOverride: "My family calendar", description: "Home", timeZone: "Europe/Paris" },
      ],
      nextPageToken: "p2",
    }).structuredContent).toEqual({
      calendars: [
        { id: "avery@example.test", summary: "avery@example.test", timeZone: "America/New_York" },
        { id: "family@group.calendar.google.com", summary: "My family calendar", description: "Home", timeZone: "Europe/Paris" },
      ],
      nextPageToken: "p2",
    });
  });

  it("passes the page token through", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ items: [] }));
    const result = await listCalendars.call({ pageToken: "p2" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual({ calendars: [] });
    expect(calls[0]!.url.searchParams.get("pageToken")).toBe("p2");
  });

  it("probes with one tiny calendar-list read", async () => {
    expect(calendarProbeRequest().query).toEqual({ maxResults: 1, fields: "items(id)" });
    const { fetch, calls } = fakeGoogle(() => json({ items: [{ id: "x" }] }));
    await probeCalendar({ accessToken: "t", fetch });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(["GET /calendar/v3/users/me/calendarList"]);
    const rejected = fakeGoogle(() => json({ error: { code: 401 } }, 401));
    await expect(probeCalendar({ accessToken: "t", fetch: rejected.fetch })).rejects.toMatchObject({ reason: "unauthenticated" });
  });
});
