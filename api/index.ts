import express from "express";
import { startServer } from "../server/dist/index.js";

// Vercel serverless entry for /api/* rewrites. startServer() skips listen() when VERCEL is set.
void express;

const { app } = await startServer();

export default app;
