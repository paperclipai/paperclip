# str-ops Plugin Foundation + Booking Spine — Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per the spec's delivery method, each Task here maps to one `agile-cycle` slice gate; `codex-critical-review` runs once per slice.

**Goal:** Stand up the `str-ops` Paperclip plugin and its booking data spine — a Postgres namespace, a mock channel provider, a booking-ingest job, and agent-callable tools — so seeded short-term-rental bookings ingest on a cron and are queryable by agents.

**Architecture:** A trusted Paperclip plugin (`packages/plugins/plugin-str-ops`) following the `plugin-llm-wiki` reference shape. Domain logic (booking ingest, availability guard) is pure and depends on a `StrOpsStore` interface; an in-memory store backs unit tests, a Postgres-namespace store backs runtime. The worker wires those behind `ctx.tools` / `ctx.jobs` via a pure `registerStrOps(ctx, deps)` function so registration is unit-testable without host internals. Provider edges (`ChannelProvider`) are interfaces with mock implementations so real Airbnb/Booking adapters drop in later unchanged.

**Tech Stack:** TypeScript (ESM), Node ≥20, `@paperclipai/plugin-sdk` (`definePlugin`/`runWorker`, `ctx.db`, `ctx.tools`, `ctx.jobs`), esbuild via `createPluginBundlerPresets`, Vitest, PostgreSQL plugin namespace `plugin_str_ops_3eae1efbf8`.

**Spec:** `docs/superpowers/specs/2026-06-02-conciergerie-str-paperclip-design.md` (§2, §3.1, §3.2, §3.3, §8 — booking spine subset).

---

## Scope (this plan = S0 + S1 only)

This plan delivers spec slices **S0** (scaffold) and **S1** (booking spine): tables `property`, `owner`, `guest`, `booking`; the `MockChannelProvider`; the `channel-poll` job (ingest only); and tools `list_properties`, `get_owner`, `list_bookings`, `check_availability`, `upsert_booking`. It produces working, testable software on its own: *cron-driven ingest of seeded bookings into the str-ops namespace, queryable by agent tools, with green unit tests.*

**Deliberately deferred to subsequent plans** (each its own working unit):
- **Plan 2 (S2–S3):** `message` table + inbound webhook + Guest-Comms agent + check-in skills; turnover/maintenance issue spawning with `ctx.issues.create` **+ `ctx.issues.requestWakeup`**; managed agents/skills/routines in the manifest.
- **Plan 3 (S4):** `financial_event` + `pricing_suggestion` tables, `pricing-sweep` job, `owner-statement` routine + statement math.
- **Plan 4 (S5):** `conciergerie-str` company package (org chart + goals) and the dashboard UI; end-to-end heartbeat demo.

Issue-spawning and agent wakeup are **out of scope for Plan 1** — the `channel-poll` job here only persists bookings and returns counts. The wakeup wiring (the spec's §5 P1 rule) lands in Plan 2 where issues first appear.

## File structure (created in this plan)

```
packages/plugins/plugin-str-ops/
├── package.json                 # plugin package (paperclipPlugin entrypoints)
├── tsconfig.json                # typecheck config (extends repo base)
├── vitest.config.ts             # vitest runner config
├── esbuild.config.mjs           # build via SDK bundler presets
├── README.md                    # short plugin readme
├── migrations/
│   └── 001_str_ops.sql          # CREATE TABLE in namespace plugin_str_ops_3eae1efbf8
├── fixtures/
│   └── seed-bookings.json       # mock channel feed (raw bookings)
└── src/
    ├── manifest.ts              # PaperclipPluginManifestV1
    ├── worker.ts                # definePlugin + runWorker; builds prod deps
    ├── register.ts              # registerStrOps(ctx, deps) — tools/jobs/data/actions
    ├── domain/
    │   ├── types.ts             # Property, Owner, Guest, Booking, RawBooking
    │   ├── availability.ts      # isAvailable / overlap logic
    │   └── ingest.ts            # ingestNewBookings(deps)
    ├── store/
    │   ├── types.ts             # StrOpsStore interface
    │   ├── memory-store.ts      # in-memory store (tests, demo seed)
    │   └── pg-store.ts          # ctx.db-backed store (runtime)
    ├── providers/
    │   ├── types.ts             # ChannelProvider/MessagingProvider/PaymentProvider
    │   └── mock-channel.ts      # MockChannelProvider (reads fixtures)
    └── seed.ts                  # demo property/owner/guest seed data
tests/  (co-located under src as *.spec.ts):
    src/domain/availability.spec.ts
    src/domain/ingest.spec.ts
    src/store/memory-store.spec.ts
    src/providers/mock-channel.spec.ts
    src/register.spec.ts
```

---

## Task 1: Scaffold the plugin package (S0)

**Files:**
- Create: `packages/plugins/plugin-str-ops/package.json`
- Create: `packages/plugins/plugin-str-ops/tsconfig.json`
- Create: `packages/plugins/plugin-str-ops/vitest.config.ts`
- Create: `packages/plugins/plugin-str-ops/esbuild.config.mjs`
- Create: `packages/plugins/plugin-str-ops/src/manifest.ts`
- Create: `packages/plugins/plugin-str-ops/src/worker.ts`
- Create: `packages/plugins/plugin-str-ops/README.md`

- [ ] **Step 1: Confirm SDK call signatures (read, do not guess).**

Read these to confirm the exact runtime API used below; adjust call sites only if a signature differs:

Run: `sed -n '1,80p' packages/plugins/sdk/src/types.ts` and `grep -nE "db|query|execute|namespace|tools|jobs|data|actions" packages/plugins/sdk/src/types.ts | head -40`

Confirm: `ctx.db.query(text, params?)` (SELECT) and `ctx.db.execute(text, params?)` (write) return shapes; `ctx.db.namespace` is the schema string; `ctx.tools.register(name, def, handler)`, `ctx.jobs.register(jobKey, handler)`, `ctx.data.register(key, handler)`, `ctx.actions.register(key, handler)` exist. (Reference usage: `packages/plugins/plugin-llm-wiki/src/worker.ts`, SDK `README.md`.)

- [ ] **Step 2: Write `package.json`** (mirrors `plugin-llm-wiki`, no UI yet)

```json
{
  "name": "@paperclipai/plugin-str-ops",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Short-term-rental conciergerie domain plugin: bookings, guests, owners, turnover, pricing.",
  "files": ["dist", "migrations", "README.md"],
  "scripts": {
    "prebuild": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps",
    "build": "node ./esbuild.config.mjs",
    "dev": "node ./esbuild.config.mjs --watch",
    "test": "vitest run --config ./vitest.config.ts",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "keywords": ["paperclip", "plugin", "str", "conciergerie"],
  "author": "Oleg",
  "license": "MIT",
  "devDependencies": {
    "@paperclipai/plugin-sdk": "workspace:*",
    "@types/node": "^24.6.0",
    "esbuild": "^0.27.3",
    "tslib": "^2.8.1",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules", "**/*.spec.ts"]
}
```

(If sibling plugins extend a different base path, match theirs: check `packages/plugins/plugin-llm-wiki/tsconfig.json`.)

- [ ] **Step 4: Write `esbuild.config.mjs`** (no UI entry in Plan 1 — worker + manifest only)

```js
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({});
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch()]);
  console.log("esbuild watch: worker + manifest");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose()]);
}
```

(If `createPluginBundlerPresets({})` requires a `uiEntry`, pass none and confirm the preset tolerates a missing UI; otherwise add a stub `src/ui/index.tsx` exporting nothing and keep the UI context. Check the preset signature from Step 1's read of `packages/plugins/sdk/src/bundlers.ts`.)

- [ ] **Step 5: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 6: Write minimal `src/manifest.ts`** (capabilities filled in Task 7; S0 needs a valid, loadable manifest)

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-str-ops";
export const DB_NAMESPACE_SLUG = "str_ops";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "STR Conciergerie Ops",
  description: "Short-term-rental domain engine: bookings, guests, owners.",
  author: "Oleg",
  categories: ["automation"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  database: {
    namespaceSlug: DB_NAMESPACE_SLUG,
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
};

export default manifest;
```

- [ ] **Step 7: Write minimal `src/worker.ts`** (S0: health only)

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("health", async () => ({ status: "ok", plugin: "str-ops" }));
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 8: Write `README.md`**

```md
# str-ops

Short-term-rental conciergerie domain plugin for Paperclip. Owns booking/guest/owner
records (Postgres namespace `plugin_str_ops_3eae1efbf8`), a mock channel provider, a
`channel-poll` ingest job, and agent-callable tools. See
`docs/superpowers/specs/2026-06-02-conciergerie-str-paperclip-design.md`.
```

- [ ] **Step 9: Install + build**

Run: `pnpm install` (repo root — picks up the new workspace package via `packages/plugins/*` glob)
Then: `pnpm --filter @paperclipai/plugin-str-ops build`
Expected: `dist/worker.js` and `dist/manifest.js` produced, no esbuild errors.

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @paperclipai/plugin-str-ops typecheck`
Expected: exits 0 (no type errors).

- [ ] **Step 11: Commit**

```bash
git add packages/plugins/plugin-str-ops
git commit -m "feat(str-ops): scaffold STR conciergerie plugin (S0)"
```

---

## Task 2: Domain types + in-memory store (TDD)

**Files:**
- Create: `packages/plugins/plugin-str-ops/src/domain/types.ts`
- Create: `packages/plugins/plugin-str-ops/src/store/types.ts`
- Create: `packages/plugins/plugin-str-ops/src/store/memory-store.ts`
- Test: `packages/plugins/plugin-str-ops/src/store/memory-store.spec.ts`

- [ ] **Step 1: Write `src/domain/types.ts`**

```ts
export type Locale = "fr" | "en";
export type BookingStatus = "pending" | "confirmed" | "cancelled";

export interface Owner {
  id: string;
  companyId: string;
  name: string;
  email: string;
  commissionPct: number;
}

export interface Property {
  id: string;
  companyId: string;
  name: string;
  externalCode: string; // channel-side code used to resolve raw bookings
  ownerId: string;
  basePriceCents: number;
  currency: string;
}

export interface Guest {
  id: string;
  companyId: string;
  name: string;
  contact: string;
  locale: Locale;
}

export interface Booking {
  id: string;
  companyId: string;
  propertyId: string;
  guestId: string;
  channel: string;
  status: BookingStatus;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  nights: number;
  grossCents: number;
  feesCents: number;
  externalRef: string;
}

// What a channel provider yields before resolution to internal ids.
export interface RawBooking {
  externalRef: string;
  channel: string;
  propertyExternalCode: string;
  guest: { name: string; contact: string; locale: Locale };
  checkIn: string;
  checkOut: string;
  grossCents: number;
  feesCents: number;
}
```

- [ ] **Step 2: Write `src/store/types.ts`**

```ts
import type { Booking, Guest, Owner, Property } from "../domain/types.js";

export interface NewGuest {
  companyId: string;
  name: string;
  contact: string;
  locale: Guest["locale"];
}

export interface NewBooking {
  companyId: string;
  propertyId: string;
  guestId: string;
  channel: string;
  status: Booking["status"];
  checkIn: string;
  checkOut: string;
  nights: number;
  grossCents: number;
  feesCents: number;
  externalRef: string;
}

export interface StrOpsStore {
  listProperties(companyId: string): Promise<Property[]>;
  getProperty(companyId: string, propertyId: string): Promise<Property | null>;
  getPropertyByExternalCode(companyId: string, externalCode: string): Promise<Property | null>;
  getOwner(companyId: string, ownerId: string): Promise<Owner | null>;
  upsertGuestByContact(guest: NewGuest): Promise<Guest>;
  findBookingByExternalRef(companyId: string, channel: string, externalRef: string): Promise<Booking | null>;
  findOverlappingBookings(companyId: string, propertyId: string, checkIn: string, checkOut: string): Promise<Booking[]>;
  insertBooking(booking: NewBooking): Promise<Booking>;
  listBookings(companyId: string, filter?: { propertyId?: string }): Promise<Booking[]>;
  // seed helpers (dev/demo)
  insertOwner(owner: Owner): Promise<Owner>;
  insertProperty(property: Property): Promise<Property>;
}
```

- [ ] **Step 3: Write `src/store/memory-store.spec.ts` (failing test first)**

```ts
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";

const CO = "company-1";

describe("MemoryStore", () => {
  it("upserts a guest idempotently by (companyId, contact)", async () => {
    const store = new MemoryStore();
    const a = await store.upsertGuestByContact({ companyId: CO, name: "Ana", contact: "ana@x.com", locale: "en" });
    const b = await store.upsertGuestByContact({ companyId: CO, name: "Ana R.", contact: "ana@x.com", locale: "en" });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Ana R."); // latest name wins
  });

  it("finds a booking by external ref scoped to channel + company", async () => {
    const store = new MemoryStore();
    const g = await store.upsertGuestByContact({ companyId: CO, name: "Ana", contact: "ana@x.com", locale: "en" });
    await store.insertBooking({
      companyId: CO, propertyId: "p1", guestId: g.id, channel: "airbnb", status: "confirmed",
      checkIn: "2026-07-01", checkOut: "2026-07-05", nights: 4, grossCents: 40000, feesCents: 4000, externalRef: "AB-1",
    });
    expect(await store.findBookingByExternalRef(CO, "airbnb", "AB-1")).not.toBeNull();
    expect(await store.findBookingByExternalRef(CO, "booking", "AB-1")).toBeNull();
    expect(await store.findBookingByExternalRef("other-co", "airbnb", "AB-1")).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/store/memory-store.spec.ts`
Expected: FAIL — `Cannot find module './memory-store.js'`.

- [ ] **Step 5: Write `src/store/memory-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Booking, Guest, Owner, Property } from "../domain/types.js";
import type { NewBooking, NewGuest, StrOpsStore } from "./types.js";

export class MemoryStore implements StrOpsStore {
  private owners: Owner[] = [];
  private properties: Property[] = [];
  private guests: Guest[] = [];
  private bookings: Booking[] = [];

  async listProperties(companyId: string): Promise<Property[]> {
    return this.properties.filter((p) => p.companyId === companyId);
  }
  async getProperty(companyId: string, propertyId: string): Promise<Property | null> {
    return this.properties.find((p) => p.companyId === companyId && p.id === propertyId) ?? null;
  }
  async getPropertyByExternalCode(companyId: string, externalCode: string): Promise<Property | null> {
    return this.properties.find((p) => p.companyId === companyId && p.externalCode === externalCode) ?? null;
  }
  async getOwner(companyId: string, ownerId: string): Promise<Owner | null> {
    return this.owners.find((o) => o.companyId === companyId && o.id === ownerId) ?? null;
  }
  async upsertGuestByContact(guest: NewGuest): Promise<Guest> {
    const existing = this.guests.find((g) => g.companyId === guest.companyId && g.contact === guest.contact);
    if (existing) {
      existing.name = guest.name;
      existing.locale = guest.locale;
      return existing;
    }
    const created: Guest = { id: randomUUID(), ...guest };
    this.guests.push(created);
    return created;
  }
  async findBookingByExternalRef(companyId: string, channel: string, externalRef: string): Promise<Booking | null> {
    return this.bookings.find(
      (b) => b.companyId === companyId && b.channel === channel && b.externalRef === externalRef,
    ) ?? null;
  }
  async findOverlappingBookings(companyId: string, propertyId: string, checkIn: string, checkOut: string): Promise<Booking[]> {
    return this.bookings.filter(
      (b) =>
        b.companyId === companyId &&
        b.propertyId === propertyId &&
        b.status !== "cancelled" &&
        b.checkIn < checkOut &&
        b.checkOut > checkIn,
    );
  }
  async insertBooking(booking: NewBooking): Promise<Booking> {
    const created: Booking = { id: randomUUID(), ...booking };
    this.bookings.push(created);
    return created;
  }
  async listBookings(companyId: string, filter?: { propertyId?: string }): Promise<Booking[]> {
    return this.bookings.filter(
      (b) => b.companyId === companyId && (!filter?.propertyId || b.propertyId === filter.propertyId),
    );
  }
  async insertOwner(owner: Owner): Promise<Owner> {
    this.owners.push(owner);
    return owner;
  }
  async insertProperty(property: Property): Promise<Property> {
    this.properties.push(property);
    return property;
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/store/memory-store.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/plugin-str-ops/src/domain packages/plugins/plugin-str-ops/src/store
git commit -m "feat(str-ops): domain types + in-memory store (S1)"
```

---

## Task 3: Availability guard (TDD)

**Files:**
- Create: `packages/plugins/plugin-str-ops/src/domain/availability.ts`
- Test: `packages/plugins/plugin-str-ops/src/domain/availability.spec.ts`

- [ ] **Step 1: Write `src/domain/availability.spec.ts` (failing test first)**

```ts
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory-store.js";
import { isPropertyAvailable, nightsBetween } from "./availability.js";

const CO = "company-1";

async function seedBooking(store: MemoryStore, checkIn: string, checkOut: string) {
  await store.insertBooking({
    companyId: CO, propertyId: "p1", guestId: "g1", channel: "airbnb", status: "confirmed",
    checkIn, checkOut, nights: nightsBetween(checkIn, checkOut), grossCents: 1, feesCents: 0, externalRef: `r-${checkIn}`,
  });
}

describe("availability", () => {
  it("computes nights between two ISO dates", () => {
    expect(nightsBetween("2026-07-01", "2026-07-05")).toBe(4);
  });

  it("is available when no overlapping booking exists", async () => {
    const store = new MemoryStore();
    await seedBooking(store, "2026-07-01", "2026-07-05");
    expect(await isPropertyAvailable(store, CO, "p1", "2026-07-05", "2026-07-08")).toBe(true); // adjacent, no overlap
  });

  it("is unavailable when dates overlap an existing non-cancelled booking", async () => {
    const store = new MemoryStore();
    await seedBooking(store, "2026-07-01", "2026-07-05");
    expect(await isPropertyAvailable(store, CO, "p1", "2026-07-04", "2026-07-06")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/domain/availability.spec.ts`
Expected: FAIL — `Cannot find module './availability.js'`.

- [ ] **Step 3: Write `src/domain/availability.ts`**

```ts
import type { StrOpsStore } from "../store/types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  return Math.round((b - a) / MS_PER_DAY);
}

export async function isPropertyAvailable(
  store: StrOpsStore,
  companyId: string,
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<boolean> {
  const overlaps = await store.findOverlappingBookings(companyId, propertyId, checkIn, checkOut);
  return overlaps.length === 0;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/domain/availability.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/plugin-str-ops/src/domain/availability.ts packages/plugins/plugin-str-ops/src/domain/availability.spec.ts
git commit -m "feat(str-ops): booking availability guard (S1)"
```

---

## Task 4: Mock channel provider + fixtures (TDD)

**Files:**
- Create: `packages/plugins/plugin-str-ops/src/providers/types.ts`
- Create: `packages/plugins/plugin-str-ops/src/providers/mock-channel.ts`
- Create: `packages/plugins/plugin-str-ops/fixtures/seed-bookings.json`
- Test: `packages/plugins/plugin-str-ops/src/providers/mock-channel.spec.ts`

- [ ] **Step 1: Write `src/providers/types.ts`**

```ts
import type { RawBooking } from "../domain/types.js";

export interface ChannelProvider {
  /** Return raw bookings observed since the plugin last polled. */
  listNewBookings(): Promise<RawBooking[]>;
}

// Declared now for the real bridge; mock impls land with their loops in later plans.
export interface MessagingProvider {
  sendMessage(input: { to: string; body: string; locale: string }): Promise<{ id: string }>;
}
export interface PaymentProvider {
  recordCharge(input: { amountCents: number; currency: string; ref: string }): Promise<{ id: string }>;
}
```

- [ ] **Step 2: Write `fixtures/seed-bookings.json`**

```json
[
  {
    "externalRef": "AB-1001",
    "channel": "airbnb",
    "propertyExternalCode": "VILLA-SUD",
    "guest": { "name": "Ana Rossi", "contact": "ana@example.com", "locale": "en" },
    "checkIn": "2026-07-10",
    "checkOut": "2026-07-17",
    "grossCents": 140000,
    "feesCents": 14000
  },
  {
    "externalRef": "BK-2002",
    "channel": "booking",
    "propertyExternalCode": "STUDIO-PORT",
    "guest": { "name": "Marc Petit", "contact": "marc@example.fr", "locale": "fr" },
    "checkIn": "2026-07-12",
    "checkOut": "2026-07-15",
    "grossCents": 36000,
    "feesCents": 3600
  }
]
```

- [ ] **Step 3: Write `src/providers/mock-channel.spec.ts` (failing test first)**

```ts
import { describe, expect, it } from "vitest";
import type { RawBooking } from "../domain/types.js";
import { MockChannelProvider } from "./mock-channel.js";

describe("MockChannelProvider", () => {
  it("returns the seeded raw bookings once, then nothing (drains its queue)", async () => {
    const seed: RawBooking[] = [{
      externalRef: "AB-1", channel: "airbnb", propertyExternalCode: "VILLA-SUD",
      guest: { name: "Ana", contact: "ana@x.com", locale: "en" },
      checkIn: "2026-07-10", checkOut: "2026-07-12", grossCents: 1, feesCents: 0,
    }];
    const provider = new MockChannelProvider(seed);
    expect(await provider.listNewBookings()).toHaveLength(1);
    expect(await provider.listNewBookings()).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/providers/mock-channel.spec.ts`
Expected: FAIL — `Cannot find module './mock-channel.js'`.

- [ ] **Step 5: Write `src/providers/mock-channel.ts`**

```ts
import type { RawBooking } from "../domain/types.js";
import type { ChannelProvider } from "./types.js";

/**
 * Deterministic mock channel. Yields its seeded raw bookings on first poll,
 * then an empty list, so a repeated `channel-poll` is idempotent in the PoC.
 */
export class MockChannelProvider implements ChannelProvider {
  private queue: RawBooking[];
  constructor(seed: RawBooking[]) {
    this.queue = [...seed];
  }
  async listNewBookings(): Promise<RawBooking[]> {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/providers/mock-channel.spec.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/plugin-str-ops/src/providers packages/plugins/plugin-str-ops/fixtures
git commit -m "feat(str-ops): mock channel provider + seed fixtures (S1)"
```

---

## Task 5: Booking ingest (TDD)

**Files:**
- Create: `packages/plugins/plugin-str-ops/src/domain/ingest.ts`
- Test: `packages/plugins/plugin-str-ops/src/domain/ingest.spec.ts`

- [ ] **Step 1: Write `src/domain/ingest.spec.ts` (failing test first)**

```ts
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory-store.js";
import { MockChannelProvider } from "../providers/mock-channel.js";
import type { RawBooking } from "./types.js";
import { ingestNewBookings } from "./ingest.js";

const CO = "company-1";

async function storeWithProperty(externalCode: string) {
  const store = new MemoryStore();
  await store.insertOwner({ id: "o1", companyId: CO, name: "Owner", email: "o@x.com", commissionPct: 20 });
  await store.insertProperty({
    id: "p1", companyId: CO, name: "Villa", externalCode, ownerId: "o1", basePriceCents: 20000, currency: "EUR",
  });
  return store;
}

const raw = (over: Partial<RawBooking> = {}): RawBooking => ({
  externalRef: "AB-1", channel: "airbnb", propertyExternalCode: "VILLA-SUD",
  guest: { name: "Ana", contact: "ana@x.com", locale: "en" },
  checkIn: "2026-07-10", checkOut: "2026-07-14", grossCents: 80000, feesCents: 8000, ...over,
});

describe("ingestNewBookings", () => {
  it("creates a booking + guest for a new raw booking on a known property", async () => {
    const store = await storeWithProperty("VILLA-SUD");
    const result = await ingestNewBookings({ companyId: CO, store, channelProvider: new MockChannelProvider([raw()]) });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.nights).toBe(4);
    expect(result.created[0]!.status).toBe("confirmed");
    expect(await store.listBookings(CO)).toHaveLength(1);
  });

  it("skips a duplicate externalRef on the same channel", async () => {
    const store = await storeWithProperty("VILLA-SUD");
    const deps = { companyId: CO, store, channelProvider: new MockChannelProvider([raw(), raw()]) };
    const result = await ingestNewBookings(deps);
    expect(result.created).toHaveLength(1);
    expect(result.skippedDuplicate).toBe(1);
  });

  it("skips a raw booking whose property code is unknown", async () => {
    const store = await storeWithProperty("VILLA-SUD");
    const result = await ingestNewBookings({ companyId: CO, store, channelProvider: new MockChannelProvider([raw({ propertyExternalCode: "NOPE" })]) });
    expect(result.created).toHaveLength(0);
    expect(result.skippedUnknownProperty).toBe(1);
  });

  it("skips a raw booking that overlaps an existing booking and flags a conflict", async () => {
    const store = await storeWithProperty("VILLA-SUD");
    await ingestNewBookings({ companyId: CO, store, channelProvider: new MockChannelProvider([raw()]) });
    const result = await ingestNewBookings({
      companyId: CO, store,
      channelProvider: new MockChannelProvider([raw({ externalRef: "AB-2", checkIn: "2026-07-12", checkOut: "2026-07-16" })]),
    });
    expect(result.created).toHaveLength(0);
    expect(result.skippedConflict).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/domain/ingest.spec.ts`
Expected: FAIL — `Cannot find module './ingest.js'`.

- [ ] **Step 3: Write `src/domain/ingest.ts`**

```ts
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
    if (!property) {
      result.skippedUnknownProperty += 1;
      continue;
    }
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/domain/ingest.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/plugin-str-ops/src/domain/ingest.ts packages/plugins/plugin-str-ops/src/domain/ingest.spec.ts
git commit -m "feat(str-ops): booking ingest with dedupe + conflict guard (S1)"
```

---

## Task 6: Migration + Postgres store (runtime persistence)

**Files:**
- Create: `packages/plugins/plugin-str-ops/migrations/001_str_ops.sql`
- Create: `packages/plugins/plugin-str-ops/src/store/pg-store.ts`

> **Schema name is fixed by the manifest id.** `plugin_str_ops_3eae1efbf8` is
> `derivePluginDatabaseNamespace("paperclipai.plugin-str-ops", "str_ops")`
> (`server/src/services/plugin-database.ts:31-44`). It was verified to reproduce
> `plugin-llm-wiki`'s known schema. **If the manifest `id` changes, re-derive** with:
> `node -e 'const c=require("crypto");console.log("plugin_str_ops_"+c.createHash("sha256").update("paperclipai.plugin-str-ops").digest("hex").slice(0,10))'`

- [ ] **Step 1: Write `migrations/001_str_ops.sql`** (host pre-creates the schema; mirror `plugin-llm-wiki` which only `CREATE TABLE`s)

```sql
CREATE TABLE plugin_str_ops_3eae1efbf8.owner (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  commission_pct numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_str_ops_3eae1efbf8.property (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  external_code text NOT NULL,
  owner_id uuid NOT NULL,
  base_price_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'EUR',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, external_code)
);

CREATE TABLE plugin_str_ops_3eae1efbf8.guest (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  contact text NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, contact)
);

CREATE TABLE plugin_str_ops_3eae1efbf8.booking (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'confirmed',
  check_in date NOT NULL,
  check_out date NOT NULL,
  nights integer NOT NULL,
  gross_cents bigint NOT NULL DEFAULT 0,
  fees_cents bigint NOT NULL DEFAULT 0,
  external_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, channel, external_ref)
);

CREATE INDEX booking_company_property_idx
  ON plugin_str_ops_3eae1efbf8.booking (company_id, property_id, check_in, check_out);
```

- [ ] **Step 2: Write `src/store/pg-store.ts`** (implements the same `StrOpsStore` interface over `ctx.db`)

> Uses the `ctx.db` surface confirmed in Task 1 Step 1. The shape below assumes
> `ctx.db.query(text, params)` → `{ rows }` and `ctx.db.execute(text, params)` → `{ rows }`,
> with `ctx.db.namespace` holding the schema string. Adjust ONLY the call wrappers
> (`q`/`x` below) if the confirmed signatures differ; row-mapping stays identical.

```ts
import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { Booking, Guest, Owner, Property } from "../domain/types.js";
import type { NewBooking, NewGuest, StrOpsStore } from "./types.js";

type Row = Record<string, unknown>;

export class PgStore implements StrOpsStore {
  constructor(private readonly db: PluginDatabaseClient) {}
  private get ns(): string {
    return this.db.namespace;
  }
  private async q(text: string, params: unknown[] = []): Promise<Row[]> {
    const res = await this.db.query(text, params);
    return (res.rows ?? []) as Row[];
  }
  private async x(text: string, params: unknown[] = []): Promise<Row[]> {
    const res = await this.db.execute(text, params);
    return (res.rows ?? []) as Row[];
  }

  private toProperty(r: Row): Property {
    return {
      id: String(r.id), companyId: String(r.company_id), name: String(r.name),
      externalCode: String(r.external_code), ownerId: String(r.owner_id),
      basePriceCents: Number(r.base_price_cents), currency: String(r.currency),
    };
  }
  private toOwner(r: Row): Owner {
    return {
      id: String(r.id), companyId: String(r.company_id), name: String(r.name),
      email: String(r.email), commissionPct: Number(r.commission_pct),
    };
  }
  private toGuest(r: Row): Guest {
    return {
      id: String(r.id), companyId: String(r.company_id), name: String(r.name),
      contact: String(r.contact), locale: (String(r.locale) === "fr" ? "fr" : "en"),
    };
  }
  private toBooking(r: Row): Booking {
    return {
      id: String(r.id), companyId: String(r.company_id), propertyId: String(r.property_id),
      guestId: String(r.guest_id), channel: String(r.channel), status: r.status as Booking["status"],
      checkIn: String(r.check_in).slice(0, 10), checkOut: String(r.check_out).slice(0, 10),
      nights: Number(r.nights), grossCents: Number(r.gross_cents), feesCents: Number(r.fees_cents),
      externalRef: String(r.external_ref),
    };
  }

  async listProperties(companyId: string): Promise<Property[]> {
    return (await this.q(`SELECT * FROM ${this.ns}.property WHERE company_id = $1 ORDER BY name`, [companyId])).map((r) => this.toProperty(r));
  }
  async getProperty(companyId: string, propertyId: string): Promise<Property | null> {
    const rows = await this.q(`SELECT * FROM ${this.ns}.property WHERE company_id = $1 AND id = $2`, [companyId, propertyId]);
    return rows[0] ? this.toProperty(rows[0]) : null;
  }
  async getPropertyByExternalCode(companyId: string, externalCode: string): Promise<Property | null> {
    const rows = await this.q(`SELECT * FROM ${this.ns}.property WHERE company_id = $1 AND external_code = $2`, [companyId, externalCode]);
    return rows[0] ? this.toProperty(rows[0]) : null;
  }
  async getOwner(companyId: string, ownerId: string): Promise<Owner | null> {
    const rows = await this.q(`SELECT * FROM ${this.ns}.owner WHERE company_id = $1 AND id = $2`, [companyId, ownerId]);
    return rows[0] ? this.toOwner(rows[0]) : null;
  }
  async upsertGuestByContact(guest: NewGuest): Promise<Guest> {
    const rows = await this.x(
      `INSERT INTO ${this.ns}.guest (id, company_id, name, contact, locale)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, contact) DO UPDATE SET name = EXCLUDED.name, locale = EXCLUDED.locale
       RETURNING *`,
      [randomUUID(), guest.companyId, guest.name, guest.contact, guest.locale],
    );
    return this.toGuest(rows[0]!);
  }
  async findBookingByExternalRef(companyId: string, channel: string, externalRef: string): Promise<Booking | null> {
    const rows = await this.q(
      `SELECT * FROM ${this.ns}.booking WHERE company_id = $1 AND channel = $2 AND external_ref = $3`,
      [companyId, channel, externalRef],
    );
    return rows[0] ? this.toBooking(rows[0]) : null;
  }
  async findOverlappingBookings(companyId: string, propertyId: string, checkIn: string, checkOut: string): Promise<Booking[]> {
    return (await this.q(
      `SELECT * FROM ${this.ns}.booking
       WHERE company_id = $1 AND property_id = $2 AND status <> 'cancelled'
         AND check_in < $4 AND check_out > $3`,
      [companyId, propertyId, checkIn, checkOut],
    )).map((r) => this.toBooking(r));
  }
  async insertBooking(b: NewBooking): Promise<Booking> {
    const rows = await this.x(
      `INSERT INTO ${this.ns}.booking
        (id, company_id, property_id, guest_id, channel, status, check_in, check_out, nights, gross_cents, fees_cents, external_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [randomUUID(), b.companyId, b.propertyId, b.guestId, b.channel, b.status, b.checkIn, b.checkOut, b.nights, b.grossCents, b.feesCents, b.externalRef],
    );
    return this.toBooking(rows[0]!);
  }
  async listBookings(companyId: string, filter?: { propertyId?: string }): Promise<Booking[]> {
    if (filter?.propertyId) {
      return (await this.q(`SELECT * FROM ${this.ns}.booking WHERE company_id = $1 AND property_id = $2 ORDER BY check_in`, [companyId, filter.propertyId])).map((r) => this.toBooking(r));
    }
    return (await this.q(`SELECT * FROM ${this.ns}.booking WHERE company_id = $1 ORDER BY check_in`, [companyId])).map((r) => this.toBooking(r));
  }
  async insertOwner(o: Owner): Promise<Owner> {
    const rows = await this.x(
      `INSERT INTO ${this.ns}.owner (id, company_id, name, email, commission_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [o.id, o.companyId, o.name, o.email, o.commissionPct],
    );
    return this.toOwner(rows[0]!);
  }
  async insertProperty(p: Property): Promise<Property> {
    const rows = await this.x(
      `INSERT INTO ${this.ns}.property (id, company_id, name, external_code, owner_id, base_price_cents, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [p.id, p.companyId, p.name, p.externalCode, p.ownerId, p.basePriceCents, p.currency],
    );
    return this.toProperty(rows[0]!);
  }
}
```

(If the SDK exports the DB client type under a different name than `PluginDatabaseClient`, import the correct type confirmed in Task 1 Step 1; the implementation is otherwise unchanged.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @paperclipai/plugin-str-ops typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/plugin-str-ops/migrations packages/plugins/plugin-str-ops/src/store/pg-store.ts
git commit -m "feat(str-ops): namespace migration + Postgres store (S1)"
```

---

## Task 7: Seed data + worker wiring + registration (TDD)

**Files:**
- Create: `packages/plugins/plugin-str-ops/src/seed.ts`
- Create: `packages/plugins/plugin-str-ops/src/register.ts`
- Modify: `packages/plugins/plugin-str-ops/src/worker.ts`
- Modify: `packages/plugins/plugin-str-ops/src/manifest.ts`
- Test: `packages/plugins/plugin-str-ops/src/register.spec.ts`

- [ ] **Step 1: Write `src/seed.ts`** (demo properties/owners; used by the `seed-demo` action and dev)

```ts
import { randomUUID } from "node:crypto";
import type { Owner, Property } from "./domain/types.js";
import type { StrOpsStore } from "./store/types.js";

export async function seedDemo(store: StrOpsStore, companyId: string): Promise<{ owners: number; properties: number }> {
  const owner: Owner = { id: randomUUID(), companyId, name: "Deborah Owner", email: "owner@example.com", commissionPct: 20 };
  await store.insertOwner(owner);
  const properties: Property[] = [
    { id: randomUUID(), companyId, name: "Villa Sud", externalCode: "VILLA-SUD", ownerId: owner.id, basePriceCents: 20000, currency: "EUR" },
    { id: randomUUID(), companyId, name: "Studio Port", externalCode: "STUDIO-PORT", ownerId: owner.id, basePriceCents: 12000, currency: "EUR" },
  ];
  for (const p of properties) await store.insertProperty(p);
  return { owners: 1, properties: properties.length };
}
```

- [ ] **Step 2: Write `src/register.spec.ts` (failing test first)** — verifies the worker registers the expected tools/job/data without needing the live host

```ts
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./store/memory-store.js";
import { MockChannelProvider } from "./providers/mock-channel.js";
import { registerStrOps, type RegisterDeps } from "./register.js";

function fakeCtx() {
  const tools = new Map<string, Function>();
  const jobs = new Map<string, Function>();
  const data = new Map<string, Function>();
  const actions = new Map<string, Function>();
  return {
    tools: { register: (name: string, _def: unknown, fn: Function) => tools.set(name, fn) },
    jobs: { register: (key: string, fn: Function) => jobs.set(key, fn) },
    data: { register: (key: string, fn: Function) => data.set(key, fn) },
    actions: { register: (key: string, fn: Function) => actions.set(key, fn) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    _maps: { tools, jobs, data, actions },
  };
}

const CO = "company-1";

describe("registerStrOps", () => {
  it("registers the booking-spine tools, the channel-poll job, and health data", () => {
    const ctx = fakeCtx();
    const deps: RegisterDeps = {
      defaultCompanyId: CO,
      store: new MemoryStore(),
      channelProvider: new MockChannelProvider([]),
    };
    registerStrOps(ctx as never, deps);
    expect([...ctx._maps.tools.keys()].sort()).toEqual(
      ["check_availability", "get_owner", "list_bookings", "list_properties", "upsert_booking"],
    );
    expect([...ctx._maps.jobs.keys()]).toContain("channel-poll");
    expect([...ctx._maps.data.keys()]).toContain("health");
  });

  it("channel-poll job ingests seeded bookings into the store", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    await store.insertOwner({ id: "o1", companyId: CO, name: "O", email: "o@x.com", commissionPct: 20 });
    await store.insertProperty({ id: "p1", companyId: CO, name: "Villa", externalCode: "VILLA-SUD", ownerId: "o1", basePriceCents: 1, currency: "EUR" });
    const channelProvider = new MockChannelProvider([{
      externalRef: "AB-1", channel: "airbnb", propertyExternalCode: "VILLA-SUD",
      guest: { name: "Ana", contact: "ana@x.com", locale: "en" },
      checkIn: "2026-07-10", checkOut: "2026-07-14", grossCents: 80000, feesCents: 8000,
    }]);
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider });
    await ctx._maps.jobs.get("channel-poll")!({ jobKey: "channel-poll", runId: "r1", trigger: "manual", scheduledAt: "" });
    expect(await store.listBookings(CO)).toHaveLength(1);
  });

  it("list_properties tool returns store rows for the company", async () => {
    const ctx = fakeCtx();
    const store = new MemoryStore();
    await store.insertOwner({ id: "o1", companyId: CO, name: "O", email: "o@x.com", commissionPct: 20 });
    await store.insertProperty({ id: "p1", companyId: CO, name: "Villa", externalCode: "V", ownerId: "o1", basePriceCents: 1, currency: "EUR" });
    registerStrOps(ctx as never, { defaultCompanyId: CO, store, channelProvider: new MockChannelProvider([]) });
    const res = await ctx._maps.tools.get("list_properties")!({ companyId: CO });
    expect(res.data.properties).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/register.spec.ts`
Expected: FAIL — `Cannot find module './register.js'`.

- [ ] **Step 4: Write `src/register.ts`**

```ts
import type { ChannelProvider } from "./providers/types.js";
import type { StrOpsStore } from "./store/types.js";
import { ingestNewBookings } from "./domain/ingest.js";
import { isPropertyAvailable, nightsBetween } from "./domain/availability.js";

export interface RegisterDeps {
  defaultCompanyId: string;
  store: StrOpsStore;
  channelProvider: ChannelProvider;
}

// Minimal structural ctx — the real PluginContext is a superset.
interface RegisterCtx {
  tools: { register(name: string, def: unknown, handler: (params: Record<string, unknown>) => Promise<unknown>): void };
  jobs: { register(jobKey: string, handler: (job: { jobKey: string; runId: string; trigger: string; scheduledAt: string }) => Promise<unknown>): void };
  data: { register(key: string, handler: (params?: Record<string, unknown>) => Promise<unknown>): void };
  logger: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

function reqString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${key} is required`);
  return v;
}

export function registerStrOps(ctx: RegisterCtx, deps: RegisterDeps): void {
  const { store, channelProvider, defaultCompanyId } = deps;
  const companyOf = (p: Record<string, unknown>) => (typeof p.companyId === "string" && p.companyId ? p.companyId : defaultCompanyId);

  ctx.data.register("health", async () => ({ status: "ok", plugin: "str-ops" }));

  ctx.tools.register("list_properties", {
    displayName: "List properties",
    description: "List STR properties for the company.",
    parametersSchema: { type: "object", properties: { companyId: { type: "string" } } },
  }, async (params) => {
    const properties = await store.listProperties(companyOf(params));
    return { content: `${properties.length} properties`, data: { properties } };
  });

  ctx.tools.register("get_owner", {
    displayName: "Get owner",
    description: "Fetch an owner by id.",
    parametersSchema: { type: "object", properties: { companyId: { type: "string" }, ownerId: { type: "string" } }, required: ["ownerId"] },
  }, async (params) => {
    const owner = await store.getOwner(companyOf(params), reqString(params, "ownerId"));
    return { content: owner ? owner.name : "not found", data: { owner } };
  });

  ctx.tools.register("list_bookings", {
    displayName: "List bookings",
    description: "List bookings for the company, optionally filtered by property.",
    parametersSchema: { type: "object", properties: { companyId: { type: "string" }, propertyId: { type: "string" } } },
  }, async (params) => {
    const propertyId = typeof params.propertyId === "string" ? params.propertyId : undefined;
    const bookings = await store.listBookings(companyOf(params), propertyId ? { propertyId } : undefined);
    return { content: `${bookings.length} bookings`, data: { bookings } };
  });

  ctx.tools.register("check_availability", {
    displayName: "Check availability",
    description: "Return whether a property is free for a date range.",
    parametersSchema: {
      type: "object",
      properties: { companyId: { type: "string" }, propertyId: { type: "string" }, checkIn: { type: "string" }, checkOut: { type: "string" } },
      required: ["propertyId", "checkIn", "checkOut"],
    },
  }, async (params) => {
    const available = await isPropertyAvailable(store, companyOf(params), reqString(params, "propertyId"), reqString(params, "checkIn"), reqString(params, "checkOut"));
    return { content: available ? "available" : "unavailable", data: { available } };
  });

  ctx.tools.register("upsert_booking", {
    displayName: "Upsert booking",
    description: "Create a confirmed booking after an availability check (manual entry).",
    parametersSchema: {
      type: "object",
      properties: {
        companyId: { type: "string" }, propertyId: { type: "string" }, channel: { type: "string" },
        externalRef: { type: "string" }, checkIn: { type: "string" }, checkOut: { type: "string" },
        guestName: { type: "string" }, guestContact: { type: "string" }, guestLocale: { type: "string" },
        grossCents: { type: "number" }, feesCents: { type: "number" },
      },
      required: ["propertyId", "channel", "externalRef", "checkIn", "checkOut", "guestName", "guestContact"],
    },
  }, async (params) => {
    const companyId = companyOf(params);
    const propertyId = reqString(params, "propertyId");
    const checkIn = reqString(params, "checkIn");
    const checkOut = reqString(params, "checkOut");
    if (!(await isPropertyAvailable(store, companyId, propertyId, checkIn, checkOut))) {
      return { content: "conflict: dates unavailable", data: { created: null, conflict: true } };
    }
    const guest = await store.upsertGuestByContact({
      companyId, name: reqString(params, "guestName"), contact: reqString(params, "guestContact"),
      locale: params.guestLocale === "fr" ? "fr" : "en",
    });
    const booking = await store.insertBooking({
      companyId, propertyId, guestId: guest.id, channel: reqString(params, "channel"),
      status: "confirmed", checkIn, checkOut, nights: nightsBetween(checkIn, checkOut),
      grossCents: typeof params.grossCents === "number" ? params.grossCents : 0,
      feesCents: typeof params.feesCents === "number" ? params.feesCents : 0,
      externalRef: reqString(params, "externalRef"),
    });
    return { content: `booking created (${booking.nights} nights)`, data: { created: booking } };
  });

  ctx.jobs.register("channel-poll", async (job) => {
    const result = await ingestNewBookings({ companyId: defaultCompanyId, store, channelProvider });
    ctx.logger.info("channel-poll ingested bookings", { runId: job.runId, ...summarize(result) });
    return summarize(result);
  });
}

function summarize(result: { created: unknown[]; skippedDuplicate: number; skippedUnknownProperty: number; skippedConflict: number }) {
  return {
    created: result.created.length,
    skippedDuplicate: result.skippedDuplicate,
    skippedUnknownProperty: result.skippedUnknownProperty,
    skippedConflict: result.skippedConflict,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @paperclipai/plugin-str-ops test -- src/register.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Update `src/worker.ts`** to build prod deps and call `registerStrOps`

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PgStore } from "./store/pg-store.js";
import { MockChannelProvider } from "./providers/mock-channel.js";
import { registerStrOps } from "./register.js";
import { readFileSync } from "node:fs";
import type { RawBooking } from "./domain/types.js";

function loadSeedBookings(): RawBooking[] {
  try {
    return JSON.parse(readFileSync(new URL("../fixtures/seed-bookings.json", import.meta.url), "utf8")) as RawBooking[];
  } catch {
    return [];
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // PoC: single company. Resolve the first company as the default scope.
    const companies = await ctx.companies.list();
    const defaultCompanyId = companies[0]?.id ?? "";
    const store = new PgStore(ctx.db);
    const channelProvider = new MockChannelProvider(loadSeedBookings());
    registerStrOps(ctx, { defaultCompanyId, store, channelProvider });

    // Demo seed action (operator-triggered).
    ctx.actions.register("seed-demo", async (params) => {
      const { seedDemo } = await import("./seed.js");
      const companyId = typeof params?.companyId === "string" && params.companyId ? params.companyId : defaultCompanyId;
      return seedDemo(store, companyId);
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

(Confirm `ctx.companies.list()` is the correct call from Task 1 Step 1; if the method differs, e.g. `ctx.companies.listForInstance()`, adjust. `companies.read` capability is already declared.)

- [ ] **Step 7: Update `src/manifest.ts`** — add capabilities, jobs, tools, and `seed-demo` is an action (not declared in manifest). Replace the capabilities array and add `jobs` + `tools`:

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-str-ops";
export const DB_NAMESPACE_SLUG = "str_ops";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "STR Conciergerie Ops",
  description: "Short-term-rental domain engine: bookings, guests, owners.",
  author: "Oleg",
  categories: ["automation"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "jobs.schedule",
    "agent.tools.register",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  database: {
    namespaceSlug: DB_NAMESPACE_SLUG,
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  jobs: [
    { jobKey: "channel-poll", displayName: "Channel poll (mock)", description: "Ingest new bookings from the mock channel provider.", schedule: "*/15 * * * *" },
  ],
  tools: [
    { name: "list_properties", displayName: "List properties", description: "List STR properties for the company.", parametersSchema: { type: "object", properties: { companyId: { type: "string" } } } },
    { name: "get_owner", displayName: "Get owner", description: "Fetch an owner by id.", parametersSchema: { type: "object", properties: { companyId: { type: "string" }, ownerId: { type: "string" } }, required: ["ownerId"] } },
    { name: "list_bookings", displayName: "List bookings", description: "List bookings, optionally by property.", parametersSchema: { type: "object", properties: { companyId: { type: "string" }, propertyId: { type: "string" } } } },
    { name: "check_availability", displayName: "Check availability", description: "Is a property free for a date range?", parametersSchema: { type: "object", properties: { companyId: { type: "string" }, propertyId: { type: "string" }, checkIn: { type: "string" }, checkOut: { type: "string" } }, required: ["propertyId", "checkIn", "checkOut"] } },
    { name: "upsert_booking", displayName: "Upsert booking", description: "Create a confirmed booking after an availability check.", parametersSchema: { type: "object", properties: { companyId: { type: "string" }, propertyId: { type: "string" }, channel: { type: "string" }, externalRef: { type: "string" }, checkIn: { type: "string" }, checkOut: { type: "string" }, guestName: { type: "string" }, guestContact: { type: "string" }, guestLocale: { type: "string" }, grossCents: { type: "number" }, feesCents: { type: "number" } }, required: ["propertyId", "channel", "externalRef", "checkIn", "checkOut", "guestName", "guestContact"] } },
  ],
};

export default manifest;
```

- [ ] **Step 8: Build + typecheck + full test run**

Run: `pnpm --filter @paperclipai/plugin-str-ops build && pnpm --filter @paperclipai/plugin-str-ops typecheck && pnpm --filter @paperclipai/plugin-str-ops test`
Expected: build emits `dist/worker.js` + `dist/manifest.js`; typecheck 0; all spec files PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/plugin-str-ops/src packages/plugins/plugin-str-ops/migrations
git commit -m "feat(str-ops): wire worker tools + channel-poll job + demo seed (S1)"
```

---

## Task 8: Install, migrate, and verify on a running instance (S1 acceptance)

**Files:** none (verification + manual acceptance)

- [ ] **Step 1: Confirm the local plugin install path.**

Read `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` (and `doc/plugins/PLUGIN_SPEC.md`) for how a repo-local plugin is registered with a running instance. Note the exact action — board **Plugins** admin UI install, or a `paperclipai` CLI plugin command, or a config entry. (The SDK README confirms local-path installs assume the source checkout on disk and that migrations run before worker startup.)

- [ ] **Step 2: Start the dev server.**

Run: `pnpm dev:once` (repo root) — starts API at `http://localhost:3100` with embedded Postgres.
Expected: server logs "Server listening"; `curl http://localhost:3100/api/health` returns ok.

- [ ] **Step 3: Install + activate the `str-ops` plugin** via the path confirmed in Step 1.
Expected: plugin loads; the host runs `migrations/001_str_ops.sql` and creates schema `plugin_str_ops_3eae1efbf8` with tables `owner`, `property`, `guest`, `booking`. Health data handler reports `{ status: "ok" }`.

- [ ] **Step 4: Seed demo data.** Trigger the `seed-demo` action (from the plugin admin UI action, or the documented action-invoke API).
Expected: returns `{ owners: 1, properties: 2 }`.

- [ ] **Step 5: Trigger `channel-poll` once** (manual job trigger from the Plugins UI / API; the scheduler also fires it every 15 min).
Expected: job result `{ created: 2, skippedDuplicate: 0, skippedUnknownProperty: 0, skippedConflict: 0 }` (both fixture bookings ingest because `VILLA-SUD` and `STUDIO-PORT` were seeded).

- [ ] **Step 6: Verify persistence.** Trigger `channel-poll` again.
Expected: `{ created: 0, skippedDuplicate: 0, ... }` — the mock provider's queue is drained, so no duplicates; bookings remain in the table (verify via the `list_bookings` tool or a DB query on `plugin_str_ops_3eae1efbf8.booking`).

- [ ] **Step 7: Repo-wide guard.**

Run: `pnpm --filter @paperclipai/plugin-str-ops test && pnpm --filter @paperclipai/plugin-str-ops typecheck`
Expected: green. (Full-repo `pnpm test` only if this plan's slice is being handed off PR-ready.)

- [ ] **Step 8: Commit any fixups from Steps 1–7.**

```bash
git add -A packages/plugins/plugin-str-ops
git commit -m "chore(str-ops): S1 install + ingest acceptance verified"
```

---

## Subsequent plans (not in this plan)

- **Plan 2 — Guest lifecycle + turnover/maintenance (S2–S3).** Adds `message` table + inbound webhook (`onWebhook`), then makes `channel-poll`/webhook **create issues and immediately call `ctx.issues.requestWakeup`** (spec §5 wakeup rule — the P1 from the codex review). Adds the Guest-Comms + Turnover managed agents, the `guest-message-triage` (FR/EN, reuses `deborah-concierge`), `checkin-instructions`, `turnover-schedule`, `maintenance-dispatch` skills, and the `issue.checked_out`/`issue.updated` subscriptions. Adds capabilities `webhooks.receive`, `issues.create|update|wakeup`, `issue.comments.create`, `issue.relations.read|write`, `agents.managed`, `skills.managed`.
- **Plan 3 — Pricing + owner reporting (S4).** Adds `financial_event` + `pricing_suggestion` tables, the `pricing-sweep` job (`0 6 * * 1`), the `owner-statement` routine (`0 6 1 * *`), statement math + `get_owner_statement` tool, and the Revenue & Owner-Relations agent. Adds `routines.managed`, `projects.managed`.
- **Plan 4 — Company package + dashboard UI (S5).** The `conciergerie-str` `agentcompanies/v1` package (COMPANY.md + the 5 agents + goals), `paperclipai company import`, and the `page`/`dashboardWidget` UI slots; end-to-end heartbeat demo.

---

## Self-review (completed by author)

- **Spec coverage (S0–S1 subset):** scaffold ✓ (T1); `str_ops` namespace + `property`/`owner`/`guest`/`booking` tables ✓ (T6); tools `list_properties`/`get_owner`/`list_bookings`/`check_availability`/`upsert_booking` ✓ (T7); `MockChannelProvider` + provider interfaces ✓ (T4); `channel-poll` cron `*/15 * * * *` ingest ✓ (T7); availability/double-booking guard ✓ (T3, T5); single-company default scope ✓ (T7 worker). Loops/issues/wakeup/financials/UI correctly deferred to Plans 2–4 and listed.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code; the two "confirm signature" steps (T1.1, T6) are real read-and-conform actions against named SDK files, not deferred work — all surrounding code is concrete.
- **Type consistency:** `StrOpsStore` method names/signatures identical across `types.ts`, `memory-store.ts`, `pg-store.ts`, and all call sites; `Booking`/`RawBooking`/`NewBooking` fields consistent across `domain/types.ts`, `store/types.ts`, `ingest.ts`, `register.ts`, `seed.ts`; tool names match between `register.ts` and `manifest.ts`; `channel-poll` jobKey identical in `register.ts` and `manifest.ts`.
