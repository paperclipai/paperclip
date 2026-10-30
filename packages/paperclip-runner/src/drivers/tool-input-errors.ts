import type { ErrorObject } from "ajv";

type SchemaError = Pick<ErrorObject, "keyword" | "message" | "schemaPath" | "params">;
const maxErrors = 8, maxBytes = 2048;

function schemaLocation(schemaPath: string): string {
  const parts = schemaPath.split("/"), location: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] === "properties" && parts[index + 1]) location.push(parts[++index]!);
    else if (parts[index] === "items") location.push("[]");
  }
  return location.length ? `/${location.join("/")}`.slice(0, 200) : "/";
}
function expected(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 80).replace(/[\uD800-\uDBFF]$/, "")) + (value.length > 80 ? "…" : "");
  if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
  return Array.isArray(value) ? "array from the tool schema" : "object from the tool schema";
}
export function toolInputValidationMessage(errors: readonly SchemaError[] | null | undefined): string {
  const details = (errors ?? []).slice(0, maxErrors).map(error => {
    let requirement = error.message ?? "is invalid";
    if (error.keyword === "const") requirement += ` (expected ${expected(error.params.allowedValue)})`;
    if (error.keyword === "enum" && Array.isArray(error.params.allowedValues)) {
      requirement += ` (expected one of ${error.params.allowedValues.slice(0, 8).map(expected).join(", ")}${error.params.allowedValues.length > 8 ? ", …" : ""})`;
    }
    return `${schemaLocation(error.schemaPath)} ${requirement.slice(0, 400).replace(/[\uD800-\uDBFF]$/, "")}`;
  });
  let message = `Invalid tool input${details.length ? `: ${details.join("; ")}` : "."}`;
  if ((errors?.length ?? 0) > maxErrors) message += "; additional validation errors omitted";
  const bytes = Buffer.from(message);
  if (bytes.length <= maxBytes) return message;
  let end = maxBytes - 3;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}
