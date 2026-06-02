import express from "express";
import { startServer } from "../server/dist/index.js";

// Vercel Express entry (https://vercel.com/docs/frameworks/backend/express).
// Static UI assets are copied to /public during build:vercel; rewrites route
// /api/* here. startServer() skips listen() when VERCEL is set.
void express;

const { app } = await startServer();

export default app;
