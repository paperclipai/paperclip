import { enableCompileCache } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

enableCompileCache(path.join(tmpdir(), "paperclip-runner-e2e-compile-cache"));
