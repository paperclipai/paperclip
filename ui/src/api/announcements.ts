import { announcementSchema, type Announcement } from "@paperclipai/shared";
import { ApiError } from "./client";

async function request(path: string, init: RequestInit) {
  const response = await fetch(`/api/announcements/${path}`, {
    credentials: "same-origin", cache: "no-store", ...init,
  });
  if (!response.ok) throw new ApiError("Announcement request failed", response.status, null);
  return response;
}

export const announcementsApi = {
  // Deliberately not coalesced by URL across account changes.
  async current(signal: AbortSignal): Promise<Announcement | null> {
    const response = await request("current", { signal });
    const payload = await response.json();
    return payload === null ? null : announcementSchema.parse(payload);
  },
  async dismiss(id: string, companyId: string, signal: AbortSignal) {
    await request(`${encodeURIComponent(id)}/dismiss`, {
      method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId }),
    });
  },
};
