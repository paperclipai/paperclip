# Governed D-840 Units/LCZ Replacement Read Contract Packet

> **Decision status:** `FAIL_CLOSED — NOT AN ADOPTED REPLACEMENT CONTRACT`
> **Confidence:** **0.96** that this packet preserves the sanctioned snapshot and refuses unsupported population; **0.00** confidence in any SKU×LCZ units or retail population because no accepted mapping or complete retail source set exists.

## Immutable source and no-write proof

- Sanctioned source: `file:/home/gus-pinsoneault/Desktop/sage_extract.db?mode=ro`
- SHA-256 before/after: `2c48aa6c32108f468e071577afbca70c56854db7055dc1a3cfeeb067befadb43` / `2c48aa6c32108f468e071577afbca70c56854db7055dc1a3cfeeb067befadb43` (`MATCH`)
- `PRAGMA query_only = 1`. Source-side statements were limited to `PRAGMA`, SQLite metadata, and `SELECT`.
- Cost source: `d840-qa.xlsx`, SHA-256 `4ea447633636816b695f87866ae97cd5c3e3cece5f0db9198c35a77605d00d5d`, 53 rows. The existing D-840 receipt remains 53 cost rows, 0 units rows, 0 retail rows, `qa_signoff=null`, `shippable=false`.

## Executable Lowe's Retail mapping

`channel2-sku-aggregate.sql` executed the sanctioned mapping `ORD_ROProduct.RetailOrderID = ORD_RetailOrder.RetailOrderID`, `ORD_RetailOrder.DealerCompanyID = COM_Company.CompanyID`, and `COM_Company.SalesChannelID = 2`, with `SKU = TRIM(CAST(ORD_ROProduct.DealerSKU AS TEXT))` and `units = SUM(COALESCE(ORD_ROProduct.DealerQty, 0))`. It produced 16 target-SKU rows and proves Lowe's Retail without the absent `ORD_RetailOrder.SalesChannelID` field.

## LCZ acceptance and 19-pair result

No governed effective-dated mapping was found. `COM_LCZLookup` has `LCZLookupID`, `CompanyId`, and `ZipCode`, but no `LCZ` label. `RetailPriceBucketID` is null for all 92 channel-2 product rows. The packet did not decode IDs, transform ZIPs, choose parent/assigned companies, use price buckets or quote/AdPatch data, allocate totals, infer values, or zero-fill.

An acceptable `d840-order-store-lcz-map.csv` (or board-approved equivalent) must be hashable and contain `mapping_version`, an exact `RetailOrderID` or expressly declared store/company/ZIP key, `lcz`, `effective_start`, `effective_end`, `date_basis`, `source_ref`, and `source_sha256`. It must yield exactly one in-domain `AH-01`/`LC-01`/`LC-13` row per order with declared date semantics. Exact-order mapping wins; no implicit fallback exists. Interval semantics are `[effective_start, effective_end)` after documented UTC normalization; missing date, overlap, no-match, out-of-domain value, or hash/version mismatch is unresolved.

Because that artifact is absent, no `units-by-sku-lcz.sql` or `.csv` was emitted. Six pairs are `PAIR_ZERO_PROVEN`; thirteen are `LCZ_UNRESOLVED`; all 19 appear exactly once in `pair-manifest.csv` with `cost_source_verdict=UNAVAILABLE-IN-APPROVED-SOURCE`.

## Retail source contract and lineage

The authorized root must contain exactly six `*_Fee_Cost_Retail_v003.xlsx` workbooks. It currently has **five**. `retail-source-manifest.csv` gives each observed full path, byte size, SHA-256, sheets, and UTC read time. Their `SSI_PROMO_UPLOAD` sheet has one `Price` field, not source-backed current/proposed retail fields, and no D-840 source lineage can be used as a substitute. `retail-lineage.csv` is intentionally header-only; no proposed-retail ≥ proposed-cost assertion is made.

Therefore `RETAIL_SOURCE_SET_UNRESOLVED` applies. The missing approved v003 workbook plus item-level `SSI_PROMO_UPLOAD` current/proposed cells and matching `Calculation_Audit` ranges must be supplied by the source owner before SKU-level lineage can broadcast only to final source-backed SKU×LCZ keys.

## Board-only residual and no-action default

The board-only decision is whether to approve a supplied effective-dated `d840-order-store-lcz-map.csv` as the mapping source, including its exact key, date basis, fallback semantics, version, and SHA-256. This does not authorize the board to infer values.

**No-action default:** without an accepted artifact, preserve six zero verdicts, keep thirteen positive pairs `LCZ_UNRESOLVED`, emit no units or retail rows, do not rebuild [SAG-8193](/SAG/issues/SAG-8193), and leave the receipt unshippable.

## Reproduction and hashes

Run `python3 scripts/build_d840_units_lcz_contract_packet.py --source-discovery`, then `python3 scripts/build_d840_units_lcz_contract_packet.py --finalize`, then `python3 scripts/build_d840_units_lcz_contract_packet.py --finish-retail-report`. The source hash must match before results are accepted.

| Artifact | SHA-256 |
|---|---|
| `channel2-sku-aggregate.csv` | `ff116a49b32a6fe94424e94627b323fb4c452514d132368294f8bbef678de471` |
| `channel2-sku-aggregate.sql` | `b95bcdb698a13948290d4c5266fbd08576eedf55b14e4403415ec7d9dd6a4b27` |
| `lcz-candidates.csv` | `5c8e9cf755a5eaf4ba38cd342a911f52d1d3978ee5068fe606e9a71b29bad8c6` |
| `lcz-discovery.sql` | `898715552d5ef7fa6ae03f75c4f33985e408fec493b2a09c7bdbaca0828d9e39` |
| `lcz-negative-controls.json` | `31c774d086326c28c23f9e136e7ceb6d366f519bf5ff395cbe116c8374e8968e` |
| `pair-manifest.csv` | `6f961ee265e922e3ce270d441fbfbdf6b1d0208bde7a886fab9e42121133b1db` |
| `retail-lineage.csv` | `918ab6522ad1971d67276cff2a84b34296fa175ef8e84c1769e8655d1b90095a` |
| `retail-reconciliation.json` | `5f1fa6fdc91121055cfa93dbdf0e16c38968e807d8413949e12a19b5ef2b18f0` |
| `retail-source-d840-matches.csv` | `7fe76f00c3f5795965e43c9b34cb0b583bc2b8b7e5565c8c6524bcf9ab1e4026` |
| `retail-source-manifest.csv` | `ddce1c11c8c5c608af71ed5e533a5376424c9016d74df101f9978a5724b7a748` |
| `schema-inventory.csv` | `9a467b92108fd69e55f7d3bec2ce8abcb9527a746018120b18c3e7c352da6426` |
| `schema-inventory.sql` | `d70148c580563b56407c0417938ad47fdf0f9b8e678ff5f8d657116efe1d8937` |
| `schema-key-metadata.csv` | `74a15fb568dc3800ed3c54a15505cb8256d192d6db1d976c400577dd0c966f1c` |
| `source-preflight.json` | `695ca6450f9790dd4727581394627a8115e2db289023f3c0311ed484b2bf120a` |
| `verification.md` | `40ae4ac4f6828353e6d9f6a0c3199c1779d36524047e0f0ab137035092fb5e06` |
