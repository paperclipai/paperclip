# D-840 contract-packet verification

- Read URI: `file:/home/gus-pinsoneault/Desktop/sage_extract.db?mode=ro`
- `PRAGMA query_only`: `1`
- SHA-256 before/after match: `True`
- Channel-2 aggregate rows: `16` (expected 16)
- Channel-2 product rows: `92` (expected 92)
- Cost-source-only pair rows: `19` (expected 19)
- Zero-proven / unresolved: `6` / `13`
- Retail workbook count: `5` (required 6) -> `RETAIL_SOURCE_SET_UNRESOLVED`
- Accepted mapping rows: `0`; no units-by-sku-lcz materialization exists.
- D-840 retail lineage rows: `0`; retail >= cost is not asserted.

## Artifact SHA-256

- `channel2-sku-aggregate.csv`: `a7af10b498b05f58a7b5672e72f1c878e8b049fb172ac1bc84b49c320e7618da`
- `channel2-sku-aggregate.sql`: `b95bcdb698a13948290d4c5266fbd08576eedf55b14e4403415ec7d9dd6a4b27`
- `lcz-candidates.csv`: `26ff857ba5ab24fe3d946ddda18e710ffa224050b2aef9a75db404e5546a5a1d`
- `lcz-discovery.sql`: `898715552d5ef7fa6ae03f75c4f33985e408fec493b2a09c7bdbaca0828d9e39`
- `lcz-negative-controls.json`: `31c774d086326c28c23f9e136e7ceb6d366f519bf5ff395cbe116c8374e8968e`
- `pair-manifest.csv`: `6f961ee265e922e3ce270d441fbfbdf6b1d0208bde7a886fab9e42121133b1db`
- `retail-lineage.csv`: `918ab6522ad1971d67276cff2a84b34296fa175ef8e84c1769e8655d1b90095a`
- `retail-reconciliation.json`: `5f1fa6fdc91121055cfa93dbdf0e16c38968e807d8413949e12a19b5ef2b18f0`
- `retail-source-d840-matches.csv`: `7fe76f00c3f5795965e43c9b34cb0b583bc2b8b7e5565c8c6524bcf9ab1e4026`
- `retail-source-manifest.csv`: `abb5c301c0f9b53d60775d5ae91621ecb2d4d74ee50d48ae6958bedfb6c4122e`
- `schema-inventory.csv`: `f54cf91cc03e28fa52beb4deb86c0733284e1790ed78eeb4d06ade175ead2a85`
- `schema-inventory.sql`: `d70148c580563b56407c0417938ad47fdf0f9b8e678ff5f8d657116efe1d8937`
- `schema-key-metadata.csv`: `26e0d6e001e8a0f1a865052dc5b0684cdf9897a96a87d69890b7c484d7456448`
- `source-preflight.json`: `8186a915caaef78d77bcec3d7770cd74ea934c36902aa393b814656595b6ee05`
- `verification.md`: `82d1506b3735a529cd4862fb9f14054683f76630d1a23b9fc8759c78e8ea8175`
