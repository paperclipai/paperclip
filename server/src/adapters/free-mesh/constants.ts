export const FREE_MESH_ADAPTER_TYPE = "free-mesh";
export const FREE_MESH_DATA_POLICY = "low_stakes_public_only";
export const DEFAULT_FREE_MESH_MODEL = "swarm-public";
export const FREE_MESH_MODELS = [
  {
    id: "swarm-public",
    label: "swarm-public (PRC public lane; public/non-confidential only)",
  },
  {
    id: "swarm-internal",
    label: "swarm-internal (US/EU lane; low-stakes TWB internal context)",
  },
] as const;
