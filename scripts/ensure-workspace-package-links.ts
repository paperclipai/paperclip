#!/usr/bin/env -S node --import tsx
import { ensureAllWorkspaceLinksCurrent } from "./ensure-workspace-package-links.mjs";

await ensureAllWorkspaceLinksCurrent();
