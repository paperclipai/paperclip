import assert from "node:assert/strict";
import test from "node:test";
import { crossVenueNames } from "./tools.js";

test("cross-venue review excludes the target and non-venue partner accounts", () => {
  assert.deepEqual(
    crossVenueNames(
      [
        { id: "target", name: "Beau-Rivage Palace", type: "Customer" },
        { id: "partner", name: "Tres Hermanos", type: "Partner" },
        { id: "supplier", name: "Distribution AG", type: "Supplier" },
        { id: "venue", name: "Hotel Walther", type: "Prospect" },
      ],
      "target",
    ),
    ["Hotel Walther"],
  );
});

test("cross-venue review keeps accounts with no type for legacy CRM records", () => {
  assert.deepEqual(crossVenueNames([{ id: "venue", name: "Legacy Hotel" }], "target"), ["Legacy Hotel"]);
});
