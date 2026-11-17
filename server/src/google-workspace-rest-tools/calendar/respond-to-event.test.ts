import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { INVITED_EVENT, RECURRING_INSTANCE, RECURRING_SERIES } from "./fixtures/calendar-rest.js";
import { respondToEvent, respondToEventRequest } from "./respond-to-event.js";

describe("respond_to_event request", () => {
  it("changes only the user's own attendee entry, guarded by the ETag, telling external guests by default", () => {
    expect(respondToEventRequest({ eventId: "evt0005invite", responseStatus: "accepted", responseComment: "See you there" }, INVITED_EVENT)).toEqual({
      method: "PATCH",
      host: "www.googleapis.com",
      path: "/calendar/v3/calendars/primary/events/evt0005invite",
      query: { sendUpdates: "externalOnly" },
      body: {
        attendees: [
          { email: "casey@partner.example.test", organizer: true, responseStatus: "accepted" },
          { email: "avery@example.test", self: true, responseStatus: "accepted", comment: "See you there" },
          { email: "drew@example.test", responseStatus: "tentative", comment: "Might be late" },
        ],
      },
      ifMatch: "\"3381234567899999\"",
    });
  });

  it.each([
    ["NONE", "none"],
    ["ALL", "all"],
    ["NOTIFICATION_LEVEL_UNSPECIFIED", "externalOnly"],
  ] as const)("notificationLevel %s sends %s", (notificationLevel, expected) => {
    expect(respondToEventRequest({ eventId: "e", responseStatus: "declined", notificationLevel }, INVITED_EVENT).query!.sendUpdates).toBe(expected);
  });

  it("keeps an earlier comment when none is given", () => {
    const attendees = (respondToEventRequest({ eventId: "e", responseStatus: "tentative" }, {
      ...INVITED_EVENT, attendees: [{ email: "avery@example.test", self: true, responseStatus: "accepted", comment: "old" }],
    }).body as { attendees: unknown[] }).attendees;
    expect(attendees).toEqual([{ email: "avery@example.test", self: true, responseStatus: "tentative", comment: "old" }]);
  });

  it("refuses when the user is not a guest", () => {
    expect(() => respondToEventRequest({ eventId: "e", responseStatus: "accepted" }, { id: "e", attendees: [{ email: "x@example.test" }] })).toThrow(/not a guest/);
    expect(() => respondToEventRequest({ eventId: "e", responseStatus: "accepted" }, { id: "e" })).toThrow(/not a guest/);
  });
});

describe("respond_to_event tool", () => {
  it("reads the event, then patches it once", async () => {
    const { fetch, calls } = fakeGoogle(({ method, body }) => json(method === "GET" ? INVITED_EVENT : { ...INVITED_EVENT, ...(body as object) }));
    const result = await respondToEvent.call({ eventId: "evt0005invite", responseStatus: "declined" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect((result.structuredContent as { attendees: Array<{ self?: boolean; responseStatus?: string }> }).attendees.find((item) => item.self)?.responseStatus).toBe("declined");
  });

  it.each([
    ["a series ID responds for the whole series", RECURRING_SERIES, { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"] }, "recurringEventId"],
    ["an occurrence ID responds for that occurrence only", RECURRING_INSTANCE, { recurringEventId: "evt0003series" }, "recurrence"],
  ] as const)("%s, and the result shows which", async (_name, event, shows, absent) => {
    const invited = { ...event, attendees: [{ email: "avery@example.test", self: true, responseStatus: "needsAction" }] };
    const { fetch, calls } = fakeGoogle(({ method, body }) => json(method === "GET" ? invited : { ...invited, ...(body as object) }));
    const result = await respondToEvent.call({ eventId: event.id!, responseStatus: "accepted" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.pathname.split("/").at(-1)}`)).toEqual([`GET ${event.id}`, `PATCH ${event.id}`]);
    expect(result.structuredContent).toMatchObject(shows);
    expect(result.structuredContent).not.toHaveProperty(absent);
  });

  it("does not write when the user is not invited, and rejects needsAction", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ ...INVITED_EVENT, attendees: [] }));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    expect((await respondToEvent.call({ eventId: "evt0005invite", responseStatus: "accepted" }, http)).isError).toBe(true);
    expect((await respondToEvent.call({ eventId: "evt0005invite", responseStatus: "needsAction" }, http)).isError).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("reports a conflicting change without claiming the outcome is unknown", async () => {
    const { fetch } = fakeGoogle(({ method }) => (method === "GET" ? json(INVITED_EVENT) : json({ error: { code: 412 } }, 412)));
    const result = await respondToEvent.call({ eventId: "evt0005invite", responseStatus: "accepted" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.content[0] as { text: string }).text).toBe("The item changed after it was read, so nothing was changed. Read it again and retry.");
  });
});
