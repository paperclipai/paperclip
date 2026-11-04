import { z } from "zod";

export const configureRailwaySshSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), grantId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("enable"), grantId: z.string().uuid(), knownHosts: z.string().min(1).max(8192) }).strict(),
  z.object({ action: z.literal("remove"), grantId: z.string().uuid() }).strict(),
]);
export type ConfigureRailwaySsh = z.infer<typeof configureRailwaySshSchema>;
export interface RailwaySshSetup {
  grantId: string;
  publicKey: string;
  knownHosts: string;
  enabled: boolean;
}
