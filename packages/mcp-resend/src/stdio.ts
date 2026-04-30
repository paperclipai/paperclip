#!/usr/bin/env node
import { runServer } from "./index.js";
void runServer().catch((e) => {
  console.error(e);
  process.exit(1);
});
