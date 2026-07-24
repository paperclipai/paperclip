import { z } from "zod";

export const adapterRegistryEntrySchema = z
  .object({
    adapterType: z.string().min(1),
    enabled: z.boolean().default(true),
    runtimeImage: z.string().optional(),
    envKeys: z.array(z.string()).optional(),
    allowFqdns: z.array(z.string()).optional(),
    probeCommand: z.array(z.string()).optional(),
    defaultEnv: z.record(z.string()).optional(),
  })
  .strict();

export const adapterRegistrySchema = z.array(adapterRegistryEntrySchema);

export type AdapterRegistryEntryParsed = z.infer<typeof adapterRegistryEntrySchema>;
