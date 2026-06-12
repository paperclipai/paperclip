#!/usr/bin/env node
// Generate a VAPID keypair for Web Push (TON-2312).
//
//   node server/scripts/generate-vapid-keys.mjs
//
// Copy the printed values into your environment (e.g. ~/.paperclip.env):
//   PAPERCLIP_VAPID_PUBLIC_KEY=...
//   PAPERCLIP_VAPID_PRIVATE_KEY=...
//   PAPERCLIP_VAPID_SUBJECT=mailto:you@example.com   # optional contact URL
//
// Keep the private key secret. The public key is exposed to browsers via
// GET /api/push/vapid-public-key so they can subscribe.
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("# Web Push VAPID keys — add these to your environment");
console.log(`PAPERCLIP_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`PAPERCLIP_VAPID_PRIVATE_KEY=${privateKey}`);
console.log("PAPERCLIP_VAPID_SUBJECT=mailto:you@example.com");
