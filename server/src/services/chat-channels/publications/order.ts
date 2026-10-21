import {
  and,
  eq,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { type AnyPgColumn } from "drizzle-orm/pg-core";

type PublicationOrderTable = {
  createdAt: AnyPgColumn;
  id: AnyPgColumn;
  payload: AnyPgColumn;
};

function publicationTransportOrderKey(table: PublicationOrderTable) {
  return sql<string>`coalesce(${table.payload}->'transportPart'->>'orderKey', ${table.id}::text)`;
}

function publicationPrecedes(
  earlier: PublicationOrderTable,
  later: PublicationOrderTable,
) {
  return or(
    lt(earlier.createdAt, later.createdAt),
    and(
      eq(earlier.createdAt, later.createdAt),
      lt(
        publicationTransportOrderKey(earlier),
        publicationTransportOrderKey(later),
      ),
    ),
  );
}

export { publicationTransportOrderKey, publicationPrecedes };
