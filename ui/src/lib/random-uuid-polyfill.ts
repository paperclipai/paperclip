// Side-effect module: imported first in main.tsx so the polyfill is in place before any other module runs.
import { installRandomUuidPolyfill } from "./uuid";

installRandomUuidPolyfill();
