import { getConnectableAppDefinition } from "./app-definitions.js";
import type { AppDefinition } from "./types/app-definition.js";

export function getAppDefinitionForApplicationKey(key: unknown): AppDefinition | null {
  if (typeof key !== "string") return null;
  const gallery = /^app-gallery:([a-z0-9]+(?:-[a-z0-9]+)*):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(key);
  return getConnectableAppDefinition(gallery ? gallery[1].toLowerCase() : key);
}
