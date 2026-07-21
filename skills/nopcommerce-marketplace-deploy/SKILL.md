---
name: nopcommerce-marketplace-deploy
description: Publish or update a nopCommerce plugin/theme on the nopCommerce.com marketplace via the seller Partner portal Upload-extension flow. Use when submitting, listing, releasing, or updating a marketplace listing, or preparing the source/compiled ZIPs, logos, screenshots, and descriptions for one.
---

# Deploy a nopCommerce Plugin/Theme to the Marketplace

## Purpose

Take a built nopCommerce plugin or theme and get it **listed (or updated) on the official
nopCommerce.com marketplace**. There is **no public deploy API** — submission is a web form in the
seller Partner portal followed by a **manual review** by the nopCommerce team. This skill covers
packaging the required artifacts, the exact form fields and their constraints, and the
**check-first / update-don't-duplicate** rule.

This skill is deployment-only. For building the plugin/theme use the **`nopcommerce`** skill. **Logos are
generated with `nanobanana`** per the **Logos** rules below (the `nopcommerce-plugin-logo` skill only
covers wiring an existing `logo.png` into the `.csproj`/admin, not creating the artwork).

## Prerequisites

- **Approved nopCommerce.com seller/partner account.** Credentials are referenced by secret key name
  only (e.g. `$NOPCOMMERCE_SELLER_USER` / `$NOPCOMMERCE_SELLER_PASSWORD`) via `secretService` —
  **never in source control**. The operator inserts credentials in the browser (copilot).
- **A browser tool** (Playwright/Chrome) — the operator logs in; the agent drives the form.
- **The built plugin/theme**, versioned to match its `plugin.json` `Version`, compiled clean (the
  `.csproj` `ClearPluginAssemblies`/`NopTarget` step strips framework DLLs from the output).
- Source repo (SplatDev baseline): `github.com/splatdevtech/SplatDev.NopCommerce.Plugins` (branch `main`).
  Local canonical clone: `/mnt/e/source/repos/nopCommerce Projects`.

### Canonical marketplace tooling (use it — don't re-derive)

The canonical repo ships a `marketplace/` folder that IS the deployment source of truth:
- **`marketplace/marketplace-listings.json`** — per-plugin `name`, `shortDesc`, `fullDesc` (HTML),
  `category`, `price`, `zipFile`, `iconKey`, `sysName`, `ready`, `supportedVersions`, `sourceCodeUrl`.
- **`scripts/build-marketplace-zips.sh`** — builds each plugin (dotnet SDK 9.0) and produces the
  ready-to-deploy ZIP **with a correct `uploadedItems.json`** (`Type`/`SupportedVersion`/
  `DirectoryPath`/`SystemName`). `--skip-build` repackages existing output. Zips are **not** committed.
- **`marketplace/images/`** — `mp-{iconKey}.png` (catalog icon) + `icon-{iconKey}.png` (banner).
- **`marketplace/SUBMISSION-GUIDE.md`** — the wave-by-wave plugin/zip/sysName/category table + login.
- Seller login credentials must be supplied by the operator through the approved secret-management flow; never document usernames, passwords, or secret locations in the skill.
- **Hosting:** built ZIPs are uploaded to **Dropbox** and referenced as `?dl=1` direct links in the two
  URL fields (free listings may instead upload the ZIP directly to nop servers).

## Workflow

### 1. Check first — reuse an existing listing; never duplicate

1. Log in, then open the seller listings: **`https://www.nopcommerce.com/en/customer/products`**
   ("My account → My extensions").
2. **ALWAYS check for an existing listing first — including ones NOT yet approved.** Scan the full
   My-extensions list for a listing of this exact plugin **in ANY status** — `Approved`, **`Under
   review` (pending)**, or `Rejected`. A pending/under-review listing for the plugin still counts:
   never create a second one just because the first isn't approved yet. Match by brand/plugin name and,
   when unsure, open the candidate's Edit page and confirm the SystemName/package. Duplicates are
   rejected and waste review cycles.
3. Decide which listing to write to, in this priority order:
   1. **A listing for THIS exact plugin already exists (any status)** → click its **Edit** link
      (`/en/upload-product/{id}`) and **update it in place** (bump the compiled/source packages, tick
      any newly-supported versions). **Never** open a second listing for the same plugin.
   2. **No listing for this plugin yet, but reusable placeholders exist → EXHAUST the placeholder pool
      before creating anything new.** The leftover **wrong-submission** rows — seen labelled
      `DELETE, it's a wrong submission` and, once claimed as a reuse slot, renamed to
      **`IGNORE, it's a wrong submission (NOW A PLACEHOLDER)`** — are a reuse pool from earlier failed
      attempts (typically `Status: Under review`). **Repurpose one**: open its **Edit** page and
      overwrite every field with the new plugin's data. You MUST use up every remaining placeholder
      before ever clicking "Upload extension". Leftover placeholders also carry **stale images** — see
      the placeholder-cleanup note in step 3.
   3. **Placeholder pool is fully exhausted** (no wrong-submission rows left in any status) → only then
      click **Upload extension** (`/en/upload-product`) to create a **fresh** listing.
3. One listing per plugin covers **all** supported nopCommerce versions in a single package — never
   make a separate listing per version.
4. **Reconcile, don't regress.** When updating an existing listing, the **live listing may be more
   current than `marketplace-listings.json`** (hand-curated descriptions, the newer category taxonomy
   e.g. `Shipping & delivery >> Shipping carriers`, live Dropbox package links). Do **not** blind-overwrite
   from the registry. Default update = **refresh the ZIP + tick any newly-supported versions**, keep the
   curated live copy, and only fix live rule violations (e.g. a short/full description that lists
   supported versions — the form forbids that). Diff registry vs live and surface conflicts to the
   operator before overwriting curated fields.

### 2. Produce the marketplace deliverables (pre-submission checklist)

Per the SplatDev nopCommerce project rules' Definition of Done, assemble **all** of these before
touching the form:

- [ ] **Compiled "ready-to-deploy" ZIP** (≤ 10 MB) — the built plugin/theme, installable via
      **Admin → Configuration → Local plugins → "Upload plugin or theme"**. It **must contain
      `uploadedItems.json`** at the archive root (a manifest mapping each supported version to its
      plugin/theme directory + `SystemName` + `Type` of `Plugin`/`Theme`). A merchant must never have
      to FTP files manually. To match the exact structure, download an official example (e.g. the
      2Checkout payment module: `/en/2checkout-payment-module`) and mirror its layout.
- [ ] **Source-code ZIP** — full source for **all** supported versions, **with no `.git`** — for the
      nop team's technical/anti-clone review. (Or a GitHub URL granting read access to
      `github.com/AndreiMaz`.)
- [ ] **Logo 140×140** and **large logo 512×512**, **generated with `nanobanana`** and **cartoonish**
      in style. Two cases (see **Logos** section below for the full rules + prompt recipe):
      - **Brand plugin** (implements a named service — MercadoPago, PagBank, Pagar.me, Correios, …):
        the logo MUST include that service's **original, unmodified brand logo** (e.g. the MercadoPago
        plugin logo embeds the real MercadoPago mark), set in a cartoonish scene.
      - **Non-brand plugin** (Motoboy, RequestGuard, …): the logo/icon must depict **what the plugin
        does** — e.g. Motoboy = a motorbike **delivery-person silhouette** with **speed dashes** behind
        the bike to show it moving fast.
- [ ] **≥ 2 screenshots** (JPG/PNG, **min width 600px**; first image is the catalog thumbnail).
      **MANDATORY for every new submission: a real screenshot of the plugin's Admin _Configure_ page.**
      **Add a front-end/storefront screenshot too whenever the plugin has a customer-facing surface**
      (payment method at checkout, shipping options at checkout, a widget on the storefront, etc.);
      admin-only plugins may use a second admin view instead. Capture these live from the store admin
      (the plugin must be installed): navigate to `Admin/<Plugin>/Configure` and, for the front-end, the
      relevant storefront page. Never ship a listing whose only images are banners/logos — the nop team
      wants to see the actual UI.
- [ ] **Short description** — plain text, **≤ 250 chars**, no HTML, no versions/pricing/superlatives.
- [ ] **Full description** — HTML, **≥ 700 chars**; features as bullets, usage examples, support/docs
      links, and (for themes, **required**) a live-demo link.

### 2a. Logos — generate with `nanobanana` (cartoonish)

Every plugin logo is **generated with `nanobanana`**, in a **cartoonish** style. Produce **BOTH sizes
and commit both to canonical** in the plugin folder:
- **`logo.png` — 140×140** (the nopCommerce plugin/admin logo, bundled in the package).
- **`logo-512.png` — 512×512** (the marketplace "large logo").

Do NOT hand-draw shapes in PIL/SVG or just download-and-resize — those don't meet the bar. (PIL is only
for the mechanical **trim-to-square + resize** of the generated art into the two sizes.)

Two cases decide the subject:

1. **Brand plugin** — the plugin implements a named third-party service (payment gateway, carrier, ERP:
   MercadoPago, PagBank, Pagar.me, Cielo, Correios, Omie, …). The logo **must contain that service's
   real, original, unmodified brand logo/mark** — do not redraw, recolor, or stylize the brand mark
   itself; place the genuine mark into a cartoonish surround. Example prompt shape:
   *"Cartoonish app icon featuring the official MercadoPago logo, unmodified, centered; playful rounded
   background; clean, flat, friendly style; 512×512."*
2. **Non-brand plugin** — the plugin is a capability, not a brand (Motoboy, RequestGuard, …). The
   logo/icon must **depict what the plugin does**. Examples:
   - **Motoboy** → a **motorbike delivery-person silhouette** with **speed dashes** behind the bike
     (conveys fast local delivery).
   - **RequestGuard** (auto-bans abusive IPs) → a guard/shield blocking bad bots.

**Deriving the prompt:** when the subject isn't obvious from the name, read the plugin's **README and
business logic** (`plugin.json` `Description`, `*Settings.cs`, `*Plugin.cs`, Configure view) and build
the prompt from what it actually does. **If it is still unclear after reading the code, ASK THE
OPERATOR** what the icon should depict — do not guess.

**Generating (nanobanana = Gemini 2.5 Flash Image).** If a nanobanana MCP is connected, use it. If it
is NOT surfaced to the session (MCP servers load at startup; a freshly-added one won't appear until the
session restarts), call the **Gemini image API directly** with an API key — this IS nanobanana:
`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=<KEY>`
with body `{"contents":[{"parts":[{"text":"<prompt>"}]}],"generationConfig":{"responseModalities":["IMAGE"]}}`;
the PNG comes back base64 in `candidates[0].content.parts[].inlineData.data`. Then **trim the white
border to a square and resize** to 512×512 (marketplace) + 140×140 (`logo.png` in the plugin/package).
Keep the API key in an env var; **never commit it.**

### 3. Fill the upload form (`/en/upload-product`, or the Edit page for updates)

Field-by-field (all `*` are required):

1. **Name** * — ≤ **57 chars**. **Pattern: `<Brand> (Brazil)`** — the brand/product name plus the
   region in parentheses. **Do NOT include:** "nopCommerce"; the vendor name ("SplatDev"); the
   **category word** ("Shipping", "Payment", "Widget", "Gateway", etc.); "best/top rated"; version; or
   price. Examples: `Correios (Brazil)`, `InfinityPay (Brazil)`, `Pagar.me (Brazil)`,
   `PagBank/PagSeguro (Brazil)`. The vendor ("SplatDev") and the category belong in the **full
   description**, never the title. When updating an existing listing whose name already matches this
   pattern, **keep it** — do not overwrite the name with the registry's "SplatDev … Gateway" string.
2. **Short description** * — ≤ **250 chars**, **no HTML**.
3. **Full description** * — ≥ **700 chars**, HTML allowed but **no `<h1>`**, **no `<script>`**, no
   large/non-standard fonts or colors; scope any custom CSS under the parent `.full-description`
   selector; verify mobile layout with the form's **Preview** button.
4. **Price** — `0.00` for free; USD; informational only (you process payments; nop takes no share).
5. **Available on your own website** ☑ — **paid → MUST tick** and self-host the package (the paid page
   on your site must allow immediate purchase, not just a contact form). Free → may leave unticked to
   host on nopCommerce servers (that reveals the direct **Upload extension package** field).
6. **Category** * — pick the correct **leaf subcategory** (parent categories can't be submitted).
7. **Supported versions** ☑ — tick every version the single package genuinely supports.
8. **Images** — the first image is the catalog thumbnail; ≤ **3 total**, min width 600px. **Reused
   placeholder listings carry stale leftover images** (e.g. an old Stripe icon) that count toward the 3
   and would otherwise become your thumbnail. The uploader has three quirks to work around:
   - **One file per input**: the jQuery MultiFile widget accepts a **single** file per `imageFiles`
     input, then clones a new empty input (`MultiFile1`, `MultiFile1_F1`, …) for the next — upload one
     file per input, not an array.
   - **`max: N` counts existing images**: with 2 leftover images you can add only 1 (a "Too many files
     — max: 1" alert), and you **cannot delete the last remaining image** ("At least one image is
     required") until a new one is committed.
   - **Deleting an image is an AJAX call that re-renders and CLEARS queued (not-yet-saved) file
     inputs.** So do deletes and uploads in this order: (1) delete what leftovers you can, (2) upload
     your screenshots **last, immediately before Save** (re-tick the terms box, which the re-render may
     have cleared).
   - **A picture deletion only COMMITS on Save** — it is form-tied, not an immediate server-side delete.
     If you delete a thumbnail and navigate away without saving (or the save then fails), the image
     comes back. Always click **Save after deleting**, then reload to verify the deletion stuck.
   - **Each image must be ≤ 500 KB** (hard server limit; the error is "Error on uploading: Image maximum
     size is 500 KB", and it makes the WHOLE save fail — reverting your deletions and uploads). Device-
     scale screenshots and detailed logos blow past this. **Compress before upload**: resize to ~1400px
     wide (screenshots) / ~1000px (logos) and save as JPG (q≈85); that lands well under 500 KB.
   - **Full swap to [logo, Configure screenshot]** on a listing that already has 2 images: delete one
     (mark), upload logo + Configure (≤500 KB each), Save → [old, logo, cfg]; reopen, delete the old
     one, **Save again**, reload to confirm [logo, cfg]. The logo (uploaded first) becomes the thumbnail.
9. **Upload extension package** — the compiled ZIP (only shown when not self-hosting).
10. **Hyperlink/instructions — source code** * — the source ZIP/repo URL (private to nop team).
11. **Hyperlink/instructions — "ready to deploy" package** * — the compiled ZIP URL (private to nop team).
12. **I agree with the author terms** * → **Save**.

### 4. Submit, verify, and track

1. Click **Save**; resolve any inline validation errors (length limits, missing required fields).
2. Back on **My extensions**, confirm the listing shows **Status: Under review**.
3. Record the listing id/URL (`/en/upload-product/{id}`) with the issue for future **updates**.
4. Attach evidence to the Paperclip issue: screenshots of the filled form + the Under-review status.
5. Await the nop team's manual approval; if rejected, read their reason, fix, and **edit the same
   listing** (never open a new one).

## Output

- A marketplace listing in **Under review** (new) or an **updated** existing listing — never a duplicate.
- The listing id/URL recorded on the issue, plus the assembled deliverables (2 ZIPs, 2 logos,
  ≥ 2 screenshots, short + full descriptions) attached as evidence.

## Notes

- **No API / no automation of the final submit** — it is a manual, reviewed web form. The agent
  prepares everything and drives the browser; the operator supplies credentials and gives go-ahead.
- **`uploadedItems.json` is the #1 packaging gotcha** — a bare plugin folder won't install via the
  admin uploader and will be rejected. Always mirror an official example package.
- **Paid vs free hosting:** commercial extensions **cannot** be stored on nopCommerce servers — they
  must be self-hosted with a working buy flow; only free extensions may use nop's servers.
- **Rejection triggers to avoid:** cloned/stolen code, `<h1>`/`<script>` or gaudy fonts in the
  description, promoting other services from the listing, description < 700 chars, a theme without a
  live demo, or duplicate listings for the same plugin.
- **Never duplicate — check pending too:** before submitting, confirm the plugin has no existing listing
  in **any** status (Approved **or** Under review/pending). A not-yet-approved listing still blocks a
  new one. Exhaust the wrong-submission **placeholder pool** before ever creating a fresh listing.
- **Logos:** always **`nanobanana`**, **cartoonish**. Brand plugins embed the service's **real,
  unmodified brand mark**; non-brand plugins depict **what the plugin does** (Motoboy → fast motorbike
  courier; RequestGuard → shield; BlockedVariations → forbidden/no-entry icon; CPF/CNPJ → ID card).
  Derive the subject from the README/business logic; **ask the operator if still unclear.**
- **Secrets:** seller credentials and any tokens are referenced by secret key name via `secretService`
  and never committed.
