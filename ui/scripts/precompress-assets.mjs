import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dir = process.argv[2];
const compressible = /\.(js|css|svg|json|wasm|txt|html)$/;
let count = 0;
let rawBytes = 0;
let brotliBytes = 0;

for (const name of fs.readdirSync(dir)) {
  if (!compressible.test(name)) continue;
  const file = path.join(dir, name);
  const source = fs.readFileSync(file);
  if (source.length < 1024) continue;
  const brotli = zlib.brotliCompressSync(source, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });
  fs.writeFileSync(`${file}.br`, brotli);
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(source, { level: 9 }));
  count += 1;
  rawBytes += source.length;
  brotliBytes += brotli.length;
}

console.log(`precompressed ${count} assets: ${(rawBytes / 1e6).toFixed(1)} MB -> ${(brotliBytes / 1e6).toFixed(1)} MB br`);
