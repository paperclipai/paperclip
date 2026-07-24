import { z } from "zod";

export const subscribePushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export type SubscribePushSubscription = z.infer<typeof subscribePushSubscriptionSchema>;

export const unsubscribePushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
});

export type UnsubscribePushSubscription = z.infer<typeof unsubscribePushSubscriptionSchema>;
