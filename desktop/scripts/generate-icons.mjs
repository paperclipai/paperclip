// Generates the desktop app icon set from one source mark.
//
// Bundling needs `.png` sizes plus Windows `.ico` and macOS `.icns`. Both of
// those formats can embed PNG data directly, so this writes them by hand
// rather than pulling an image toolchain into the repo. Re-run it after editing
// the mark:
//
//   node desktop/scripts/generate-icons.mjs
//
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconDir = join(here, "..", "src-tauri", "icons");

/** Brand-neutral rounded square with a lighter diagonal fold, drawn per pixel. */
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const inset = size * 0.06;

  const insideRoundedSquare = (x, y) => {
    const min = inset;
    const max = size - inset;
    if (x < min || y < min || x > max || y > max) return false;
    const cx = Math.min(Math.max(x, min + radius), max - radius);
    const cy = Math.min(Math.max(y, min + radius), max - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      if (!insideRoundedSquare(x + 0.5, y + 0.5)) {
        // Transparent outside the rounded square.
        pixels[offset + 3] = 0;
        continue;
      }
      // Diagonal fold: top-left is lighter, bottom-right is deeper.
      const t = (x + y) / (2 * size);
      const r = Math.round(24 + t * 26);
      const g = Math.round(30 + t * 60);
      const b = Math.round(58 + t * 120);
      // A lighter wedge across the upper-left third reads as a folded corner.
      const wedge = x + y < size * 0.9;
      pixels[offset] = wedge ? Math.min(255, r + 46) : r;
      pixels[offset + 1] = wedge ? Math.min(255, g + 52) : g;
      pixels[offset + 2] = wedge ? Math.min(255, b + 58) : b;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type 0 (none)
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * ICO with classic 32-bit DIB entries.
 *
 * PNG-compressed entries are legal in an `.ico` and smaller, but `rc.exe` (which
 * tauri-build invokes to embed the Windows icon) rejects them with RC2175, so
 * the entries here are a BITMAPINFOHEADER plus a bottom-up BGRA bitmap and an
 * empty AND mask. Alpha carries the rounded-corner transparency.
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const images = entries.map(({ size, pixels }) => dibBitmap(size, pixels));
  let offset = 6 + entries.length * 16;
  const directory = entries.map(({ size }, index) => {
    const image = images[index];
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.length;
    return entry;
  });

  return Buffer.concat([header, ...directory, ...images]);
}

/** BITMAPINFOHEADER + BGRA rows (bottom-up) + a fully transparent AND mask. */
function dibBitmap(size, pixels) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height: XOR + AND masks stacked
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bit count
  header.writeUInt32LE(0, 16); // compression: BI_RGB
  const xorSize = size * size * 4;
  header.writeUInt32LE(xorSize, 20); // image size

  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < size; y += 1) {
    // DIB rows run bottom-up.
    const sourceRow = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const from = (sourceRow * size + x) * 4;
      const to = (y * size + x) * 4;
      xor[to] = pixels[from + 2]; // B
      xor[to + 1] = pixels[from + 1]; // G
      xor[to + 2] = pixels[from]; // R
      xor[to + 3] = pixels[from + 3]; // A
    }
  }

  // AND mask: one bit per pixel, rows padded to 4 bytes. All zero: alpha rules.
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  return Buffer.concat([header, xor, mask]);
}

/** ICNS with PNG-encoded `ic07` (128) and `ic08` (256) members. */
function encodeIcns(members) {
  const blocks = members.map(({ type, png }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const total = 8 + blocks.reduce((sum, block) => sum + block.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...blocks]);
}

mkdirSync(iconDir, { recursive: true });

const sizes = [32, 128, 256, 512];
const pngBySize = new Map(sizes.map((size) => [size, encodePng(size, drawIcon(size))]));

writeFileSync(join(iconDir, "icon.png"), pngBySize.get(512));
for (const size of [32, 128, 256]) {
  writeFileSync(join(iconDir, `${size}x${size}.png`), pngBySize.get(size));
}
// Tauri's own icon templates emit this name for the retina slot.
writeFileSync(join(iconDir, "128x128@2x.png"), pngBySize.get(256));
// Keep the ico small. Every entry here is an uncompressed 32-bit DIB, so a
// 256px entry alone costs 256 KB, and Windows scales a 48px icon perfectly well
// for the shell's window and taskbar. The PNG set carries the large sizes.
writeFileSync(
  join(iconDir, "icon.ico"),
  encodeIco([16, 32, 48].map((size) => ({ size, pixels: drawIcon(size) }))),
);
writeFileSync(join(iconDir, "icon.icns"), encodeIcns([
  { type: "ic07", png: pngBySize.get(128) },
  { type: "ic08", png: pngBySize.get(256) },
]));

console.log(`wrote icons to ${iconDir}`);