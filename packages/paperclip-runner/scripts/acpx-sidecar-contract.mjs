const SCHEMA_ID_PATTERN =
  /^https:\/\/paperclip\.dev\/schemas\/acpx-sidecar\/v([1-9]\d*)\/message\.schema\.json$/;
const PROTOCOL_VERSION_REF = "#/$defs/protocolVersion";

export function readAcpxSidecarProtocolVersion(schema) {
  const schemaIdMatch = SCHEMA_ID_PATTERN.exec(schema?.$id ?? "");
  const protocolVersion = Number(schemaIdMatch?.[1]);
  if (!Number.isSafeInteger(protocolVersion)) {
    throw new Error(
      "ACPX sidecar schema $id must declare a positive safe-integer protocol version",
    );
  }

  if (schema?.$defs?.protocolVersion?.const !== protocolVersion) {
    throw new Error(
      "ACPX sidecar protocol version must match its authoritative schema $id",
    );
  }

  for (const family of ["request", "response", "event"]) {
    const versionSchema = schema?.$defs?.[family]?.properties?.protocolVersion;
    if (
      Object.keys(versionSchema ?? {}).length !== 1 ||
      versionSchema?.$ref !== PROTOCOL_VERSION_REF
    ) {
      throw new Error(
        `ACPX ${family} schema must use the shared protocol version`,
      );
    }
  }

  return protocolVersion;
}
