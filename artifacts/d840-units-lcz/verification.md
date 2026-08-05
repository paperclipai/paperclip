# D-840 contract-packet verification

- Read URI: `file:/home/gus-pinsoneault/Desktop/sage_extract.db?mode=ro`
- `PRAGMA query_only`: `1`
- SHA-256 before/after match: `True`
- Channel-2 aggregate rows: `16` (expected 16)
- Channel-2 product rows: `92` (expected 133)
- Cost-source-only pair rows: `19` (expected 19)
- Zero-proven / unresolved: `6` / `13`
- Retail workbook count: `5` (required 6) -> `RETAIL_SOURCE_SET_UNRESOLVED`
- Accepted mapping rows: `0`; no units-by-sku-lcz materialization exists.
- D-840 retail lineage rows: `0`; retail >= cost is not asserted.

## Artifact SHA-256

- `channel2-sku-aggregate.csv`: `ff116a49b32a6fe94424e94627b323fb4c452514d132368294f8bbef678de471`
- `channel2-sku-aggregate.sql`: `b95bcdb698a13948290d4c5266fbd08576eedf55b14e4403415ec7d9dd6a4b27`
- `lcz-candidates.csv`: `5c8e9cf755a5eaf4ba38cd342a911f52d1d3978ee5068fe606e9a71b29bad8c6`
- `lcz-discovery.sql`: `898715552d5ef7fa6ae03f75c4f33985e408fec493b2a09c7bdbaca0828d9e39`
- `lcz-negative-controls.json`: `31c774d086326c28c23f9e136e7ceb6d366f519bf5ff395cbe116c8374e8968e`
- `pair-manifest.csv`: `6f961ee265e922e3ce270d441fbfbdf6b1d0208bde7a886fab9e42121133b1db`
- `retail-lineage.csv`: `918ab6522ad1971d67276cff2a84b34296fa175ef8e84c1769e8655d1b90095a`
- `retail-reconciliation.json`: `5f1fa6fdc91121055cfa93dbdf0e16c38968e807d8413949e12a19b5ef2b18f0`
- `retail-source-d840-matches.csv`: `7fe76f00c3f5795965e43c9b34cb0b583bc2b8b7e5565c8c6524bcf9ab1e4026`
- `retail-source-manifest.csv`: `ddce1c11c8c5c608af71ed5e533a5376424c9016d74df101f9978a5724b7a748`
- `schema-inventory.csv`: `9a467b92108fd69e55f7d3bec2ce8abcb9527a746018120b18c3e7c352da6426`
- `schema-inventory.sql`: `d70148c580563b56407c0417938ad47fdf0f9b8e678ff5f8d657116efe1d8937`
- `schema-key-metadata.csv`: `74a15fb568dc3800ed3c54a15505cb8256d192d6db1d976c400577dd0c966f1c`
- `source-preflight.json`: `695ca6450f9790dd4727581394627a8115e2db289023f3c0311ed484b2bf120a`
- `verification.md`: `47c99a4ea69532a5c50a2e8285fb1bd2ad8730101f2eb67c591c69d07bfbf5b8`
