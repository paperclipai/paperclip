import { DEFAULT_RUNTIME_PROFILES, type RuntimeProfileDefinition } from "@paperclipai/shared";

function cloneProfile(profile: RuntimeProfileDefinition): RuntimeProfileDefinition {
  return { ...profile };
}

export interface RuntimeProfileRegistry {
  list(): RuntimeProfileDefinition[];
  upsert(profile: RuntimeProfileDefinition): RuntimeProfileDefinition[];
}

export function createRuntimeProfileRegistry(
  seedProfiles: RuntimeProfileDefinition[] = DEFAULT_RUNTIME_PROFILES,
): RuntimeProfileRegistry {
  const profiles = new Map<string, RuntimeProfileDefinition>();
  for (const profile of seedProfiles) {
    profiles.set(profile.id, cloneProfile(profile));
  }

  return {
    list() {
      return Array.from(profiles.values()).map(cloneProfile);
    },
    upsert(profile) {
      profiles.set(profile.id, cloneProfile(profile));
      return Array.from(profiles.values()).map(cloneProfile);
    },
  };
}
