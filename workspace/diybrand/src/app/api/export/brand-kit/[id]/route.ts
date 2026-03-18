import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  brandQuestionnaire,
  brandPalette,
  brandTypography,
  brandLogos,
  orders,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import JSZip from "jszip";
import { readLogo } from "@/lib/storage";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const queryStartTime = performance.now();

  // Verify payment
  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json(
      { error: "Payment required" },
      { status: 402 }
    );
  }

  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.stripeSessionId, sessionId),
        eq(orders.questionnaireId, id)
      )
    )
    .limit(1);

  if (!order || !order.paidAt) {
    return NextResponse.json(
      { error: "Payment not found or not completed" },
      { status: 402 }
    );
  }

  // Fetch all brand data in parallel
  const [
    [questionnaire],
    [palette],
    [typography],
    selectedLogos
  ] = await Promise.all([
    db
      .select()
      .from(brandQuestionnaire)
      .where(eq(brandQuestionnaire.id, id))
      .limit(1),
    db
      .select()
      .from(brandPalette)
      .where(
        and(eq(brandPalette.questionnaireId, id), eq(brandPalette.selected, true))
      )
      .limit(1),
    db
      .select()
      .from(brandTypography)
      .where(
        and(
          eq(brandTypography.questionnaireId, id),
          eq(brandTypography.selected, true)
        )
      )
      .limit(1),
    db
      .select()
      .from(brandLogos)
      .where(
        and(eq(brandLogos.questionnaireId, id), eq(brandLogos.selected, true))
      )
  ]);

  const queryEndTime = performance.now();
  const queryDuration = queryEndTime - queryStartTime;

  if (!questionnaire) {
    return NextResponse.json(
      { error: "Brand kit not found" },
      { status: 404 }
    );
  }

  if (!palette && !typography && selectedLogos.length === 0) {
    return NextResponse.json(
      { error: "No brand assets selected yet" },
      { status: 400 }
    );
  }

  const brandName = questionnaire.businessName || "Brand";
  const zip = new JSZip();

  // --- Logos ---
  if (selectedLogos.length > 0) {
    const logoFolder = zip.folder("logos")!;
    for (const logo of selectedLogos) {
      const ext = logo.mimeType?.split("/")[1] || "png";
      const filename = `${logo.name.toLowerCase().replace(/\s+/g, "-")}.${ext}`;

      // Prefer file-based storage
      if (logo.imagePath) {
        const buffer = await readLogo(logo.imagePath);
        if (buffer) {
          logoFolder.file(filename, buffer);
          continue;
        }
      }

      // Fallback: decode legacy base64 data URI
      if (logo.imageData) {
        const match = logo.imageData.match(
          /^data:image\/(\w+);base64,(.+)$/
        );
        if (match) {
          logoFolder.file(filename, match[2], { base64: true });
        }
      }
    }
  }

  // --- Color palette ---
  if (palette) {
    const paletteFolder = zip.folder("colors")!;

    // JSON reference
    paletteFolder.file(
      "palette.json",
      JSON.stringify(
        {
          name: palette.name,
          colors: palette.colors,
        },
        null,
        2
      )
    );

    // CSS custom properties
    const cssVars = palette.colors!
      .map(
        (c) => `  --color-${c.role}: ${c.hex};`
      )
      .join("\n");
    paletteFolder.file(
      "palette.css",
      `:root {\n${cssVars}\n}\n`
    );

    // HTML swatch page
    const swatchCards = palette.colors!
      .map(
        (c) => `
    <div style="flex:1;min-width:140px;text-align:center">
      <div style="background:${c.hex};height:120px;border-radius:12px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)"></div>
      <strong style="text-transform:capitalize">${c.role}</strong>
      <div style="color:#666;font-size:14px">${c.hex}</div>
      <div style="color:#999;font-size:12px">HSL(${c.hsl.h}, ${c.hsl.s}%, ${c.hsl.l}%)</div>
    </div>`
      )
      .join("");

    paletteFolder.file(
      "palette.html",
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${brandName} — Color Palette</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; background: #fafafa; color: #111; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    p { color: #666; margin-bottom: 32px; }
  </style>
</head>
<body>
  <h1>${brandName} — Color Palette</h1>
  <p>${palette.name}</p>
  <div style="display:flex;gap:20px;flex-wrap:wrap">
    ${swatchCards}
  </div>
</body>
</html>`
    );
  }

  // --- Typography guide ---
  if (typography) {
    const typoFolder = zip.folder("typography")!;

    const googleFontsUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(typography.headingFamily)}:wght@${typography.headingWeight}&family=${encodeURIComponent(typography.bodyFamily)}:wght@${typography.bodyWeight}&display=swap`;

    typoFolder.file(
      "typography.json",
      JSON.stringify(
        {
          name: typography.name,
          heading: {
            family: typography.headingFamily,
            weight: typography.headingWeight,
            category: typography.headingCategory,
          },
          body: {
            family: typography.bodyFamily,
            weight: typography.bodyWeight,
            category: typography.bodyCategory,
          },
          googleFontsUrl,
        },
        null,
        2
      )
    );

    typoFolder.file(
      "typography.html",
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${brandName} — Typography Guide</title>
  <link rel="stylesheet" href="${googleFontsUrl}">
  <style>
    body { font-family: '${typography.bodyFamily}', ${typography.bodyCategory}; font-weight: ${typography.bodyWeight}; max-width: 720px; margin: 40px auto; padding: 0 20px; background: #fafafa; color: #111; line-height: 1.6; }
    h1, h2, h3 { font-family: '${typography.headingFamily}', ${typography.headingCategory}; font-weight: ${typography.headingWeight}; }
    .pair-name { color: #666; font-size: 14px; margin-bottom: 32px; }
    .specimen { border: 1px solid #e5e5e5; border-radius: 12px; padding: 32px; background: #fff; margin-bottom: 24px; }
    .label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #999; margin-bottom: 8px; }
    .meta { font-size: 14px; color: #666; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>${brandName} — Typography Guide</h1>
  <p class="pair-name">${typography.name}</p>

  <div class="specimen">
    <div class="label">Heading</div>
    <h2 style="margin:0">${typography.headingFamily}</h2>
    <div class="meta">${typography.headingCategory} · weight ${typography.headingWeight}</div>
    <h1 style="margin:24px 0 0">The quick brown fox jumps over the lazy dog</h1>
  </div>

  <div class="specimen">
    <div class="label">Body</div>
    <h2 style="margin:0;font-family:'${typography.bodyFamily}',${typography.bodyCategory};font-weight:${typography.bodyWeight}">${typography.bodyFamily}</h2>
    <div class="meta">${typography.bodyCategory} · weight ${typography.bodyWeight}</div>
    <p style="margin:24px 0 0;font-size:16px">
      Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
      Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
    </p>
  </div>

  <div class="specimen">
    <div class="label">Pairing Preview</div>
    <h2 style="margin:0 0 16px">Welcome to ${brandName}</h2>
    <p style="margin:0">
      This is how your heading and body fonts work together. The contrast between
      <strong>${typography.headingFamily}</strong> (headings) and
      <strong>${typography.bodyFamily}</strong> (body) creates visual hierarchy and readability.
    </p>
  </div>
</body>
</html>`
    );

    // CSS snippet
    typoFolder.file(
      "typography.css",
      `@import url('${googleFontsUrl}');

:root {
  --font-heading: '${typography.headingFamily}', ${typography.headingCategory};
  --font-heading-weight: ${typography.headingWeight};
  --font-body: '${typography.bodyFamily}', ${typography.bodyCategory};
  --font-body-weight: ${typography.bodyWeight};
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  font-weight: var(--font-heading-weight);
}

body, p, li, span {
  font-family: var(--font-body);
  font-weight: var(--font-body-weight);
}
`
    );
  }

  // --- README ---
  const readmeLines = [`# ${brandName} — Brand Kit\n`];
  readmeLines.push(
    `Generated by [diybrand.app](https://diybrand.app) on ${new Date().toISOString().slice(0, 10)}\n`
  );
  readmeLines.push("## Contents\n");
  if (selectedLogos.length > 0) {
    readmeLines.push("- **logos/** — Selected logo files");
  }
  if (palette) {
    readmeLines.push(
      "- **colors/** — Color palette (JSON, CSS custom properties, visual HTML swatch)"
    );
  }
  if (typography) {
    readmeLines.push(
      "- **typography/** — Typography guide (JSON, CSS, visual HTML specimen)"
    );
  }
  readmeLines.push("\n## Quick Start\n");
  readmeLines.push(
    "1. Open the HTML files in your browser for a visual reference"
  );
  readmeLines.push("2. Copy CSS variables from the `.css` files into your project");
  readmeLines.push(
    "3. Use the JSON files for programmatic access to your brand tokens"
  );

  zip.file("README.md", readmeLines.join("\n") + "\n");

  // Generate ZIP
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const safeFilename = brandName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeFilename}-brand-kit.zip"`,
      "Content-Length": String(zipBuffer.length),
      "Server-Timing": `db;dur=${queryDuration.toFixed(2)};desc="Database queries"`,
    },
  });
}
