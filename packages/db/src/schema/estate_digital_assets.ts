import { pgEnum, pgTable, uuid, text, timestamp, numeric, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const digitalAssetTypeEnum = pgEnum("digital_asset_type", [
  "cryptocurrency",
  "nft",
  "domain",
  "token",
  "defi_position",
  "other",
]);

export const estateDigitalAssets = pgTable(
  "estate_digital_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    digitalAssetType: digitalAssetTypeEnum("digital_asset_type").notNull().default("cryptocurrency"),
    ticker: text("ticker"),
    blockchain: text("blockchain"),
    quantityHeld: numeric("quantity_held", { precision: 30, scale: 18 }),
    // Wallet addresses stored as jsonb — app layer should encrypt sensitive values
    walletAddresses: jsonb("wallet_addresses").$type<Array<{ label: string; address: string; blockchain?: string; isHardware: boolean; encryptedSeed?: string }>>(),
    // Exchange accounts (no raw credentials — just metadata)
    exchangeAccounts: jsonb("exchange_accounts").$type<Array<{ exchangeName: string; accountId?: string; notes?: string }>>(),
    // Cold storage documentation
    coldStorageDocIds: text("cold_storage_doc_ids").array(),
    // NFT-specific
    contractAddress: text("contract_address"),
    tokenId: text("token_id"),
    // Access recovery info (store doc references only, never secrets in plaintext)
    recoveryDocIds: text("recovery_doc_ids").array(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetIdx: index("estate_digital_asset_idx").on(table.assetId),
    companyUserIdx: index("estate_digital_company_user_idx").on(table.companyId, table.userId),
    tickerIdx: index("estate_digital_ticker_idx").on(table.companyId, table.ticker),
  }),
);
