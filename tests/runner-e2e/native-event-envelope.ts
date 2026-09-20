export function isValidNativePrpEnvelope(
  envelope: Record<string, unknown>,
  protocolSchemaVersion: unknown,
) {
  const version = envelope.schemaVersion;
  const validSchema =
    (envelope.schema === "paperclip.prp.event.v1" && version === 1) ||
    (envelope.schema === "paperclip.prp.event.v2" && version === 2);
  return validSchema && protocolSchemaVersion === version;
}
