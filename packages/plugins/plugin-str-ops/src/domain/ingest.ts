import type { ChannelProvider } from "../providers/types.js";
import type { StrOpsStore } from "../store/types.js";
import type { Booking } from "./types.js";
import { isPropertyAvailable, nightsBetween } from "./availability.js";

export interface IngestDeps {
  companyId: string;
  store: StrOpsStore;
  channelProvider: ChannelProvider;
}

export interface IngestResult {
  created: Booking[];
  skippedDuplicate: number;
  skippedUnknownProperty: number;
  skippedConflict: number;
}

export async function ingestNewBookings(deps: IngestDeps): Promise<IngestResult> {
  const { companyId, store, channelProvider } = deps;
  const result: IngestResult = { created: [], skippedDuplicate: 0, skippedUnknownProperty: 0, skippedConflict: 0 };

  for (const raw of await channelProvider.listNewBookings()) {
    if (await store.findBookingByExternalRef(companyId, raw.channel, raw.externalRef)) {
      result.skippedDuplicate += 1;
      continue;
    }
    const property = await store.getPropertyByExternalCode(companyId, raw.propertyExternalCode);
    if (!property) { result.skippedUnknownProperty += 1; continue; }
    if (!(await isPropertyAvailable(store, companyId, property.id, raw.checkIn, raw.checkOut))) {
      result.skippedConflict += 1;
      continue;
    }
    const guest = await store.upsertGuestByContact({
      companyId, name: raw.guest.name, contact: raw.guest.contact, locale: raw.guest.locale,
    });
    const booking = await store.insertBooking({
      companyId,
      propertyId: property.id,
      guestId: guest.id,
      channel: raw.channel,
      status: "confirmed",
      checkIn: raw.checkIn,
      checkOut: raw.checkOut,
      nights: nightsBetween(raw.checkIn, raw.checkOut),
      grossCents: raw.grossCents,
      feesCents: raw.feesCents,
      externalRef: raw.externalRef,
    });
    result.created.push(booking);
  }
  return result;
}
