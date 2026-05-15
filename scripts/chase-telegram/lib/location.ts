import type { StoredLocation, LocationSource } from "../types.ts";

const userLocations = new Map<number, StoredLocation>();

export function setUserLocation(
  chatId: number,
  latitude: number,
  longitude: number,
  source: LocationSource,
  venueInfo?: { title?: string; address?: string },
): void {
  userLocations.set(chatId, {
    latitude,
    longitude,
    updatedAt: Date.now(),
    ...(venueInfo?.title ? { venueTitle: venueInfo.title } : {}),
    ...(venueInfo?.address ? { venueAddress: venueInfo.address } : {}),
  });
}

export function getUserLocation(chatId: number): StoredLocation | undefined {
  return userLocations.get(chatId);
}

export function clearUserLocation(chatId: number): void {
  userLocations.delete(chatId);
}

export function formatLocationDisplay(loc: StoredLocation): string {
  const lat = loc.latitude.toFixed(4);
  const lon = loc.longitude.toFixed(4);
  return `${lat}, ${lon}`;
}

export function getLocationContextString(chatId: number): string | null {
  const loc = userLocations.get(chatId);
  if (!loc) return null;
  const coords = formatLocationDisplay(loc);
  const parts = [`The user's last known location is at coordinates ${coords}.`];
  if (loc.venueTitle) {
    parts.push(`They are at ${loc.venueTitle}${loc.venueAddress ? ` (${loc.venueAddress})` : ""}.`);
  }
  return parts.join(" ");
}

export function getStoredLocationCount(): number {
  return userLocations.size;
}

export function clearAllLocations(): void {
  userLocations.clear();
}
