export function paperclipCloudEnrollmentPrincipal(actor: { userId?: string | null; source?: string | null }): string {
  return actor.userId ? `user:${actor.userId}` : `source:${actor.source ?? "board"}`;
}
