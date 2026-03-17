/**
 * Seed script for evohaus real-world projects (pilot: MersinSteel + Navico).
 *
 * Usage:
 *   DATABASE_URL=... EVOHAUS_COMPANY_ID=... npx tsx packages/db/src/seed-evohaus-projects.ts
 *
 * Requires:
 *   - EVOHAUS_COMPANY_ID: The UUID of the EVOHAUS AI company in Paperclip
 *   - DATABASE_URL: PostgreSQL connection string
 */

import { createDb } from "./client.js";
import { projects, projectProfiles, projectIntegrations, projectScrapers } from "./schema/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const companyId = process.env.EVOHAUS_COMPANY_ID;
if (!companyId) throw new Error("EVOHAUS_COMPANY_ID is required");

const db = createDb(url);

console.log("Seeding evohaus projects...");

// ── MersinSteel (Muhittin Muhasebe / MaliPanel) ──

const [mersinProject] = await db
  .insert(projects)
  .values({
    companyId,
    name: "MersinSteel MaliPanel",
    description: "Multi-tenant SaaS muhasebe sistemi — Celik Boru San. Tic. Ltd. Sti.",
    status: "in_progress",
    color: "#3b82f6",
  })
  .returning();

await db.insert(projectProfiles).values({
  projectId: mersinProject!.id,
  companyId,
  slug: "mersin-steel",
  customerName: "Celik Boru San. Tic. Ltd. Sti.",
  customerContact: "Muhittin Ozdemir",
  businessModel: "SaaS muhasebe (*.malipanel.evohaus.org)",
  productionUrl: "mersinsteel.evohaus.org",
  hostPort: 3007,
  vpsDirectory: "/opt/mersin-steel",
  dbSchema: "muhittin",
  techStack: {
    framework: "Next.js 16",
    runtime: "React 19",
    css: "Tailwind 4",
    stateManagement: "React Query",
    orm: "Supabase",
  },
  moduleStats: {
    pages: 28,
    apiEndpoints: 14,
    hooks: 34,
    queries: 57,
    parsers: 7,
    schemas: 15,
  },
  iosCompanion: {
    repoName: "MersinSteel-iOS",
    framework: "SwiftUI",
    minVersion: "iOS 17+",
  },
  phase: "production",
});

await db.insert(projectIntegrations).values([
  {
    projectId: mersinProject!.id,
    companyId,
    integrationType: "google_drive",
    name: "Drive Sync (5 dosya + 4 klasor)",
    config: { files: 5, folders: 4 },
  },
  {
    projectId: mersinProject!.id,
    companyId,
    integrationType: "efatura",
    name: "UBL-TR e-Fatura XML",
    config: { format: "UBL-TR", parser: "fast-xml-parser" },
  },
  {
    projectId: mersinProject!.id,
    companyId,
    integrationType: "bank_reconciliation",
    name: "Banka Mutabakati",
    config: { matchEngine: "fuzzy", vknMatcher: true },
  },
  {
    projectId: mersinProject!.id,
    companyId,
    integrationType: "mistral_ocr",
    name: "Iade Fatura OCR",
    config: { model: "mistral", fallback: "text-based" },
  },
]);

console.log(`  Created MersinSteel project: ${mersinProject!.id}`);

// ── Navico Fleet Management ──

const [navicoProject] = await db
  .insert(projects)
  .values({
    companyId,
    name: "Navico Fleet Management",
    description: "GPS/telematik filo yonetimi — 7 provider, 19 cron job, canli arac takibi",
    status: "in_progress",
    color: "#10b981",
  })
  .returning();

await db.insert(projectProfiles).values({
  projectId: navicoProject!.id,
  companyId,
  slug: "navico",
  customerName: "Blue Eagle Lojistik",
  customerContact: "Navico Admin",
  businessModel: "SaaS fleet management (arac basi faturalandirma)",
  productionUrl: "navico.evohaus.org",
  hostPort: 3003,
  vpsDirectory: "/opt/navico",
  dbSchema: "navico",
  techStack: {
    framework: "Next.js 14",
    runtime: "React 18",
    css: "Tailwind",
    stateManagement: "SWR",
    orm: "Supabase",
    additionalLibs: ["MapLibre GL", "Recharts", "node-cron"],
  },
  moduleStats: {
    pages: 20,
    apiEndpoints: 52,
  },
  iosCompanion: {
    repoName: "Navico-iOS",
    framework: "SwiftUI",
    minVersion: "iOS 17+",
  },
  phase: "production",
});

await db.insert(projectScrapers).values([
  {
    projectId: navicoProject!.id,
    companyId,
    name: "Arvento",
    port: 9526,
    vpsDirectory: "/root/arvento-scraper",
  },
  {
    projectId: navicoProject!.id,
    companyId,
    name: "Mobiliz",
    port: 8765,
    vpsDirectory: "/root/mobiz-scraper",
  },
  {
    projectId: navicoProject!.id,
    companyId,
    name: "Seyir Mobil",
    port: 9530,
    vpsDirectory: "/root/seyir_mobil_scraper",
  },
  {
    projectId: navicoProject!.id,
    companyId,
    name: "Seyir Link",
    port: 8100,
    vpsDirectory: "/root/seyir_link_scraper",
  },
  {
    projectId: navicoProject!.id,
    companyId,
    name: "GPS Buddy",
    port: 8003,
    vpsDirectory: "/root/gpsbuddy-scraper",
  },
  {
    projectId: navicoProject!.id,
    companyId,
    name: "Oregon",
    port: 8200,
    vpsDirectory: "/root/oregon_scraper",
  },
  {
    projectId: navicoProject!.id,
    companyId,
    name: "GZC24",
    vpsDirectory: "/root/gzc24-scraper",
  },
]);

console.log(`  Created Navico project: ${navicoProject!.id}`);
console.log("Done! Two pilot projects seeded.");

process.exit(0);
