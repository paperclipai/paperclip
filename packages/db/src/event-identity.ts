import { customType } from "drizzle-orm/pg-core";

/** Historical serial identities retain their exact value. New identities are
 * random UUIDs; the abandoned serial sequence is never advanced again. */
export const eventIdentity = customType<{ data: string | number; driverData: string }>({
  dataType: () => "text",
  toDriver: value => String(value),
  fromDriver: value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value,
});
