const { readFileSync } = require("fs");
try {
  const envBuf = readFileSync("/proc/2309570/environ");
  const envParts = envBuf.toString().split("\0");
  for (const part of envParts) {
    if (part.startsWith("DATABASE_URL=")) {
      const url = part.substring("DATABASE_URL=".length);
      console.log("Found DATABASE_URL, length:", url.length);
      console.log("Masked URL:", url.replace(/:[^@:]+@/, ":***@"));
    }
  }
} catch (e) {
  console.error("Error reading environ:", e);
}
