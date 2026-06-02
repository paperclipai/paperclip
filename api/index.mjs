import express from "express";
import { startServer } from "../server/dist/index.js";

// Vercel serverless entry for /api/* rewrites. Uses compiled server output only.
void express;

const { app } = await startServer();

export default app;
