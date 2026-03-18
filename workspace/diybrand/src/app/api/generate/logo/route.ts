import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { brandQuestionnaire, brandPalette, brandLogos } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { generateLogos } from "@/lib/logo";
import { saveLogo, deleteLogo } from "@/lib/storage";
import { withTiming, measureAsync, jsonWithTimings } from "@/lib/timing";

export const POST = withTiming(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { questionnaireId } = body;

    if (!questionnaireId) {
      return NextResponse.json(
        { error: "questionnaireId is required" },
        { status: 400 }
      );
    }

    let dbTime = 0;
    let storageTime = 0;

    // Load questionnaire
    const [[questionnaire], loadTime] = await measureAsync(() =>
      db
        .select()
        .from(brandQuestionnaire)
        .where(eq(brandQuestionnaire.id, questionnaireId))
        .limit(1)
    );
    dbTime += loadTime;

    if (!questionnaire) {
      return NextResponse.json(
        { error: "Questionnaire not found" },
        { status: 404 }
      );
    }

    // Load selected palette
    const [[palette], paletteTime] = await measureAsync(() =>
      db
        .select()
        .from(brandPalette)
        .where(
          and(
            eq(brandPalette.questionnaireId, questionnaireId),
            eq(brandPalette.selected, true)
          )
        )
        .limit(1)
    );
    dbTime += paletteTime;

    const colors = palette?.colors ?? [
      { role: "primary", hex: "#6d28d9" },
      { role: "secondary", hex: "#4f46e5" },
      { role: "accent", hex: "#f59e0b" },
    ];

    const businessName = questionnaire.businessName ?? "Brand";
    const industry = questionnaire.industry ?? "Other";
    const personality = (questionnaire.brandPersonality as string[]) ?? [];

    // Generate logos via Gemini
    const [concepts, aiTime] = await measureAsync(() =>
      generateLogos(businessName, industry, personality, colors)
    );

    // Delete previously generated logo files and DB rows
    const [oldLogos, selectOldTime] = await measureAsync(() =>
      db
        .select({ imagePath: brandLogos.imagePath })
        .from(brandLogos)
        .where(eq(brandLogos.questionnaireId, questionnaireId))
    );
    dbTime += selectOldTime;

    for (const old of oldLogos) {
      if (old.imagePath) {
        const [, deleteTime] = await measureAsync(() => deleteLogo(old.imagePath));
        storageTime += deleteTime;
      }
    }

    const [, deleteDbTime] = await measureAsync(() =>
      db
        .delete(brandLogos)
        .where(eq(brandLogos.questionnaireId, questionnaireId))
    );
    dbTime += deleteDbTime;

    // Persist new logos: save files first, then insert DB rows
    const insertValues = [];
    for (const c of concepts) {
      // Generate a temporary ID for the filename
      const tempId = crypto.randomUUID();
      const [imagePath, saveTime] = await measureAsync(() =>
        saveLogo(tempId, c.imageBuffer, c.mimeType)
      );
      storageTime += saveTime;

      insertValues.push({
        id: tempId,
        questionnaireId,
        name: c.name,
        variant: c.variant,
        imagePath,
        mimeType: c.mimeType,
        prompt: c.prompt,
        selected: false,
      });
    }

    const [rows, insertTime] = await measureAsync(() =>
      db
        .insert(brandLogos)
        .values(insertValues)
        .returning()
    );
    dbTime += insertTime;

    return jsonWithTimings(
      {
        logos: rows.map((r) => ({
          id: r.id,
          name: r.name,
          variant: r.variant,
          imageUrl: `/api/logos/${r.id}/image`,
        })),
      },
      {
        timings: [
          { name: "db", duration: dbTime, description: "Database queries" },
          { name: "ai", duration: aiTime, description: "AI logo generation" },
          { name: "storage", duration: storageTime, description: "File operations" },
        ],
      }
    );
  } catch (err) {
    console.error("Logo generation error:", err);
    const message =
      err instanceof Error ? err.message : "Something went wrong";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
