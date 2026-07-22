export function defaultMeetingId(
  meetings: Array<{ id?: unknown }>,
  requestedMeetingId?: unknown,
): string | undefined {
  if (typeof requestedMeetingId === "string" && requestedMeetingId) {
    return requestedMeetingId;
  }
  return typeof meetings[0]?.id === "string" ? meetings[0].id : undefined;
}
