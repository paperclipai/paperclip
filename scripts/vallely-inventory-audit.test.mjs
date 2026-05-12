import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMarkdownReport,
  evaluateAlert,
  normalizeListing,
  parseInventoryDetail,
  summarizeListings,
} from "./vallely-inventory-audit.mjs";

describe("vallely inventory audit", () => {
  it("flags synthetic stale listings and missing photos above the alert threshold", () => {
    const now = new Date("2026-05-12T00:00:00.000Z");
    const listings = [
      normalizeListing(
        {
          id: "fresh",
          url: "https://www.vallelymarine.com/New-Inventory-Fresh-1",
          inventoryKind: "new",
          lastUpdatedAt: "2026-05-10",
        },
        { fetchOk: true, productId: "fresh", photoCount: 1, salePrice: "$12,345.00" },
        now,
      ),
      normalizeListing(
        {
          id: "stale",
          url: "https://www.vallelymarine.com/New-Inventory-Stale-2",
          inventoryKind: "new",
          lastUpdatedAt: "2026-04-01",
        },
        { fetchOk: true, productId: "stale", photoCount: 0, salePrice: "$10,000.00" },
        now,
      ),
    ];

    const summary = summarizeListings(listings, now);
    const alert = evaluateAlert(summary, { thresholdPercent: 5 });

    assert.equal(summary.totalListings, 2);
    assert.equal(summary.staleListings, 1);
    assert.equal(summary.missingPhotos, 1);
    assert.equal(summary.missingPrice, 0);
    assert.equal(alert.alert, true);
    assert.match(alert.breaches.join("\n"), /stale inventory 50% > 5%/);
    assert.match(alert.breaches.join("\n"), /missing photos 50% > 5%/);
  });

  it("parses Dealer Spike detail price and image signals", () => {
    const detail = parseInventoryDetail(
      `
      <html><head><title>2026 Yamaha MT-07 XC11882 | Vallely</title></head>
      <script>var vehicle = {"bike":"2026 Yamaha MT-07","make":"Yamaha","model":"MT-07","stockno":"XC11882","location":"Minot ND"};</script>
      <script>window.utag_data = {"product_id":"18704968","product_price":"0","product_msrp":"8599","product_name":"2026 Yamaha MT-07"};</script>
      <div id="invUnitSlider">
        <img src="https://cdn.dealerspike.com/imglib/v1/800x600/imglib/trimsdb/26405791-0-149061041.jpg">
        <img src="https://cdn.dealerspike.com/imglib/nimg/400x300/no-image-generic.jpg">
      </div><!-- .invUnitImgSlider -->
      <li class="liUnit LiInvMSRPPrice"><label class="lblUnitLabel">MSRP</label><span class="spnUnitValue">$8,599.00</span></li>
      </html>
      `,
      "https://www.vallelymarine.com/New-Inventory-2026-Yamaha-Motorcycle-Scooter-MT-07-Minot-ND-18704968",
    );

    const listing = normalizeListing(
      {
        id: "18704968",
        url: detail.url,
        inventoryKind: "new",
        lastUpdatedAt: "2026-05-09",
      },
      detail,
      new Date("2026-05-12T00:00:00.000Z"),
    );

    assert.equal(detail.productId, "18704968");
    assert.equal(detail.photoCount, 1);
    assert.equal(listing.missingPhotos, false);
    assert.equal(listing.missingPrice, true);
    assert.equal(listing.msrp, 8599);
    assert.equal(listing.publicFeedSyncStatus, "public_detail_synced");
  });

  it("builds a markdown report with required summary counts", () => {
    const now = new Date("2026-05-12T00:00:00.000Z");
    const listings = [
      normalizeListing(
        { id: "1", url: "https://example.test/1", inventoryKind: "pre-owned", lastUpdatedAt: "2026-04-01" },
        { fetchOk: true, productId: "1", photoCount: 0 },
        now,
      ),
    ];
    const report = buildMarkdownReport({ summary: summarizeListings(listings, now), listings });

    assert.match(report, /Total listings: 1/);
    assert.match(report, /Stale listings >7 days: 1/);
    assert.match(report, /Missing photos: 1/);
    assert.match(report, /Missing public price: 1/);
    assert.match(report, /manufacturer portal sync status is not exposed/i);
  });
});
