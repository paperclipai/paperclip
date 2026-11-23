import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import type { RestEvent } from "./event.js";
import { ALL_DAY_EVENT, eventList, RECURRING_INSTANCE, TIMED_EVENT } from "./fixtures/calendar-rest.js";
import {
  decodePageToken,
  encodePageToken,
  eventTypes,
  listEvents,
  listEventsRequest,
  listEventsWindow,
  MAX_SORTED_EVENTS,
  needsCalendarTimeZone,
  newestFirstPage,
} from "./list-events.js";

const NOW = new Date("2026-11-17T15:00:00Z");
const iso = (instant: number) => new Date(instant).toISOString();

describe("list_events time range", () => {
  it.each([
    ["defaults to now and 7 days later", {}, undefined, "2026-11-17T15:00:00.000Z", "2026-11-24T15:00:00.000Z"],
    ["reads offset-less times in the given zone", { startTime: "2026-11-18T09:00:00", endTime: "2026-11-18T17:00:00" }, "America/Los_Angeles", "2026-11-18T17:00:00.000Z", "2026-11-19T01:00:00.000Z"],
    ["uses a stated offset as is", { startTime: "2026-11-18T09:00:00+01:00", endTime: "2026-11-18T10:00:00Z" }, undefined, "2026-11-18T08:00:00.000Z", "2026-11-18T10:00:00.000Z"],
    ["reads a date alone as local midnight", { startTime: "2026-11-18", endTime: "2026-11-19" }, "Asia/Tokyo", "2026-11-17T15:00:00.000Z", "2026-11-18T15:00:00.000Z"],
    ["adds 7 local days across the end of DST", { startTime: "2026-10-28T09:00:00" }, "America/New_York", "2026-10-28T13:00:00.000Z", "2026-11-04T14:00:00.000Z"],
    ["a range on the DST change day is 25 hours long", { startTime: "2026-11-01", endTime: "2026-11-02" }, "America/New_York", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])("%s", (_name, input, timeZone, timeMin, timeMax) => {
    const window = listEventsWindow(input, timeZone, NOW);
    expect([iso(window.timeMin), iso(window.timeMax)]).toEqual([timeMin, timeMax]);
  });

  it("refuses an empty or reversed range", () => {
    expect(() => listEventsWindow({ startTime: "2026-11-18T10:00:00Z", endTime: "2026-11-18T10:00:00Z" }, undefined, NOW)).toThrow(/after startTime/);
  });

  it.each([
    [{}, false],
    [{ startTime: "2026-11-18T09:00:00Z" }, false],
    [{ startTime: "2026-11-18T09:00:00" }, true],
    [{ endTime: "2026-11-18" }, true],
    [{ startTime: "2026-11-18T09:00:00", timeZone: "UTC" }, false],
  ])("needs the calendar's time zone for %j: %s", (input, expected) => {
    expect(needsCalendarTimeZone(input)).toBe(expected);
  });
});

describe("list_events request", () => {
  const window = { timeMin: Date.parse("2026-11-17T00:00:00Z"), timeMax: Date.parse("2026-11-24T00:00:00Z") };

  it("expands recurring events into occurrences and filters to the default event types", () => {
    expect(listEventsRequest({ calendarId: "team@example.test", fullText: "review" }, window, { pageToken: "p2" })).toEqual({
      method: "GET",
      host: "www.googleapis.com",
      path: "/calendar/v3/calendars/team%40example.test/events",
      query: {
        timeMin: "2026-11-17T00:00:00.000Z",
        timeMax: "2026-11-24T00:00:00.000Z",
        singleEvents: true,
        orderBy: undefined,
        maxResults: 100,
        pageToken: "p2",
        q: "review",
        timeZone: undefined,
        eventTypes: ["default", "outOfOffice", "focusTime", "fromGmail"],
      },
    });
  });

  it.each([
    ["default", undefined],
    ["startTime", "startTime"],
    ["startTimeDesc", "startTime"],
    ["lastModified", "updated"],
  ] as const)("orders %s as %s", (orderBy, expected) => {
    expect(listEventsRequest({ orderBy }, window).query!.orderBy).toBe(expected);
  });

  it("maps event types, including the deprecated filter", () => {
    expect(eventTypes({ eventType: ["WORKING_LOCATION", "BIRTHDAY", "EVENT_TYPE_UNSPECIFIED"] })).toEqual(["workingLocation", "birthday", "default"]);
    expect(eventTypes({ eventTypeFilter: ["focusTime", "OUT_OF_OFFICE"] })).toEqual(["focusTime", "outOfOffice"]);
    expect(() => eventTypes({ eventTypeFilter: ["meeting"] })).toThrow(/unknown event type/);
  });
});

describe("list_events tool", () => {
  it("reads the calendar's time zone first when a time has no offset", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.searchParams.get("fields") === "timeZone"
      ? json({ timeZone: "Europe/Paris" })
      : json(eventList([TIMED_EVENT, ALL_DAY_EVENT, RECURRING_INSTANCE], { timeZone: "Europe/Paris", nextPageToken: "n2" }))));
    const result = await listEvents.call({ startTime: "2026-11-17T09:00:00", endTime: "2026-11-17T18:00:00" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get("maxResults")).toBe("1");
    expect(calls[1]!.url.searchParams.get("timeMin")).toBe("2026-11-17T08:00:00.000Z");
    expect(calls[1]!.url.searchParams.getAll("eventTypes")).toEqual(["default", "outOfOffice", "focusTime", "fromGmail"]);
    expect(result.structuredContent).toMatchObject({
      summary: "avery@example.test",
      timeZone: "Europe/Paris",
      accessRole: "owner",
      events: [{ id: "evt0001timed" }, { id: "evt0002allday", start: { date: "2026-11-20" } }, { id: "evt0003series_20261118T150000Z", recurringEventId: "evt0003series" }],
      nextPageToken: encodePageToken({ timeMin: Date.parse("2026-11-17T08:00:00Z"), timeMax: Date.parse("2026-11-17T17:00:00Z"), googleToken: "n2" }),
    });
  });

  it("keeps the first page's time range for every later page, without reading the time zone again", async () => {
    const { fetch, calls } = fakeGoogle(() => json(eventList([TIMED_EVENT], { nextPageToken: "n3" })));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    const first = await listEvents.call({}, http);
    const token = (first.structuredContent as { nextPageToken: string }).nextPageToken;
    const second = await listEvents.call({ pageToken: token, startTime: "2030-01-01T00:00:00" }, http);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("timeMin")).toBe(calls[0]!.url.searchParams.get("timeMin"));
    expect(calls[1]!.url.searchParams.get("timeMax")).toBe(calls[0]!.url.searchParams.get("timeMax"));
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("n3");
    expect(second.isError).toBeUndefined();
  });

  it.each([
    ["a raw Google token", "CiAKGjBpN", undefined],
    ["garbage after the prefix", "pc1.!!!", undefined],
    ["a reversed range", encodePageToken({ timeMin: 2, timeMax: 1, googleToken: "x" }), undefined],
    ["a newest-first token for the default order", encodePageToken({ timeMin: 1, timeMax: 2, offset: 3 }), undefined],
    ["a default-order token for newest first", encodePageToken({ timeMin: 1, timeMax: 2, googleToken: "x" }), "startTimeDesc"],
  ] as const)("refuses %s as a page token", (_name, token, orderBy) => {
    expect(() => decodePageToken(token, orderBy)).toThrow(/nextPageToken from list_events/);
  });

  it("does not read the calendar's time zone when the caller gives one", async () => {
    const { fetch, calls } = fakeGoogle(() => json(eventList([])));
    await listEvents.call({ startTime: "2026-11-17T09:00:00", timeZone: "Asia/Kolkata" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("timeMin")).toBe("2026-11-17T03:30:00.000Z");
    expect(calls[0]!.url.searchParams.get("timeZone")).toBe("Asia/Kolkata");
  });

  it("rejects an unknown time zone without calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const result = await listEvents.call({ timeZone: "Mars/Olympus" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("list_events newest first", () => {
  const events = (count: number, from = 0): RestEvent[] => Array.from({ length: count }, (_, index) => ({
    id: `e${from + index}`,
    start: { dateTime: new Date(Date.UTC(2026, 10, 1, 0, from + index)).toISOString() },
  }));

  it("reads every page in ascending order, then pages newest first with its own tokens", async () => {
    const pages: Record<string, ReturnType<typeof eventList>> = {
      first: eventList(events(250), { nextPageToken: "p2" }),
      p2: eventList(events(5, 250)),
    };
    const { fetch, calls } = fakeGoogle(({ url }) => json(pages[url.searchParams.get("pageToken") ?? "first"]));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    const input = { startTime: "2026-11-01T00:00:00Z", endTime: "2026-11-02T00:00:00Z", orderBy: "startTimeDesc" as const, pageSize: 3 };
    const first = await listEvents.call(input, http);
    expect(calls.map((call) => call.url.searchParams.get("orderBy"))).toEqual(["startTime", "startTime"]);
    expect(calls.map((call) => call.url.searchParams.get("maxResults"))).toEqual(["250", "250"]);
    expect((first.structuredContent as { events: Array<{ id: string }> }).events.map((event) => event.id)).toEqual(["e254", "e253", "e252"]);
    const window = { timeMin: Date.parse("2026-11-01T00:00:00Z"), timeMax: Date.parse("2026-11-02T00:00:00Z") };
    expect(first.structuredContent).toMatchObject({ nextPageToken: encodePageToken({ ...window, offset: 3 }) });
    const second = await listEvents.call({ ...input, pageToken: encodePageToken({ ...window, offset: 3 }) }, http);
    expect((second.structuredContent as { events: Array<{ id: string }> }).events.map((event) => event.id)).toEqual(["e251", "e250", "e249"]);
    expect(calls.slice(2).every((call) => !call.url.searchParams.get("pageToken")?.startsWith("pc1."))).toBe(true);
  });

  it("ends without a token on the last page", () => {
    const result = newestFirstPage(eventList([]), events(4), { pageSize: 3 }, { timeMin: 1, timeMax: 2 }, 3);
    expect(result.structuredContent).toEqual(expect.not.objectContaining({ nextPageToken: expect.anything() }));
    expect((result.structuredContent as { events: Array<{ id: string }> }).events.map((event) => event.id)).toEqual(["e0"]);
  });

  it("refuses a Google page token and too many events", async () => {
    let page = 0;
    const { fetch } = fakeGoogle(() => json(eventList(events(250), { nextPageToken: `p${++page}` })));
    const result = await listEvents.call({ startTime: "2026-01-01T00:00:00Z", endTime: "2026-12-31T00:00:00Z", orderBy: "startTimeDesc" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(String(MAX_SORTED_EVENTS));
  });
});
