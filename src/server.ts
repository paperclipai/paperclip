import express from "express";
import { startServer } from "../server/dist/index.js";

// Vercel Express entry (https://vercel.com/docs/frameworks/backend/express).
// Static UI assets are copied to /public during build:vercel; API + SPA fallback
// stay in the compiled Express app.
void express;

void startServer().catch((err) => {
  console.error("Valadrien OS failed to start:", err);
  process.exit(1);
});
