import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const PI_BINARY = Object.freeze({
  version: "0.84.2",
  url: "https://github.com/earendil-works/pi/releases/download/v0.84.2/pi-linux-x64.tar.gz",
  archiveSha256: "906fbe787fd225c4ac624fe7ebd5b1d55a60e0f5c7ef51795d231564f9ee1c13",
  executableSha256: "9a2d20fab3caacbe3517d91e59d495ccc49fd4b51a1a72dcec6e8c1f4b7d6ab2",
});

/** Install the official standalone runtime so ACPX never launches ambient `pi`. */
export async function materializePiBinary(packageDirectory, options = {}) {
  if ((options.platform ?? process.platform) !== "linux" || (options.arch ?? process.arch) !== "x64") {
    throw new Error("The qualified Pi binary requires Linux x64");
  }
  const temporary = await mkdtemp(join(tmpdir(), "paperclip-pi-binary-"));
  try {
    const response = await (options.fetch ?? fetch)(PI_BINARY.url);
    if (!response.ok || !response.body) throw new Error("Pi runtime download failed");
    const archive = join(temporary, "pi.tar.gz");
    const digest = createHash("sha256");
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > 192 * 1024 * 1024) return done(new Error("Pi runtime archive exceeds its size bound"));
      digest.update(chunk); done(null, chunk);
    } }), createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    if (digest.digest("hex") !== PI_BINARY.archiveSha256) throw new Error("Pi runtime archive integrity mismatch");
    const destination = join(packageDirectory, "vendor", "standalone");
    await mkdir(destination, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", destination]);
    const executable = join(destination, "pi");
    const executableDigest = createHash("sha256");
    for await (const chunk of createReadStream(executable)) executableDigest.update(chunk);
    if (executableDigest.digest("hex") !== PI_BINARY.executableSha256) throw new Error("Pi runtime executable integrity mismatch");
    await chmod(executable, 0o755);
    return executable;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
