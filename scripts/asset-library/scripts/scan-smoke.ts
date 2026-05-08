import { scanFilename, scanUpload } from "../lib/forbidden-source-scan";

async function expect(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) {
    console.log("  got:", JSON.stringify(got));
    console.log("  want:", JSON.stringify(want));
    process.exitCode = 1;
  }
}

async function main() {
  await expect(
    "shutterstock_123456.jpg blocks",
    scanFilename("shutterstock_123456.jpg").kind,
    "block",
  );
  await expect(
    "AdobeStock_98765.png blocks",
    scanFilename("AdobeStock_98765.png").kind,
    "block",
  );
  await expect(
    "GettyImages-12345-final.jpg blocks",
    scanFilename("GettyImages-12345-final.jpg").kind,
    "block",
  );
  await expect(
    "clean local-flux-output.png passes",
    scanFilename("local-flux-output.png").kind,
    "pass",
  );
  await expect(
    "shutterstock_pdf-extension passes filename (no rule)",
    scanFilename("shutterstock_123.pdf").kind,
    "pass",
  );
  // EXIF: pass empty buffer
  const empty = Buffer.from([]);
  await expect(
    "empty buffer passes EXIF",
    (await scanUpload("nofile.jpg", empty)).kind,
    "pass",
  );
}

main();
