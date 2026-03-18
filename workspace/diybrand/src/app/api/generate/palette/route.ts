import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { brandQuestionnaire, brandPalette } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generatePalettes } from "@/lib/palette";
import { withTiming, measureAsync, jsonWithTimings } from "@/lib/timing";

export const POST = withTiming(async (request: NextRequest) => {
  try {
    const body = await request.json();

    let industry: string;
    let personality: string[];

    let dbTime = 0;

    if (body.questionnaireId) {
      // Load from DB
      const [[q], loadTime] = await measureAsync(() =>
        db
          .select()
          .from(brandQuestionnaire)
          .where(eq(brandQuestionnaire.id, body.questionnaireId))
          .limit(1)
      );
      dbTime += loadTime;

      if (!q) {
        return NextResponse.json({ error: "Questionnaire not found" }, { status: 404 });
      }

      industry = q.industry ?? "Other";
      personality = (q.brandPersonality as string[]) ?? [];
    } else {
      // Accept inline data
      industry = body.industry ?? "Other";
      personality = body.brandPersonality ?? [];
    }

    const [palettes, genTime] = await measureAsync(() =>
      Promise.resolve(generatePalettes(industry, personality, 4))
    );

    // Persist generated palettes if we have a questionnaire ID
    if (body.questionnaireId) {
      // Remove any previously generated (unselected) palettes for this questionnaire
      const [, deleteTime] = await measureAsync(() =>
        db
          .delete(brandPalette)
          .where(eq(brandPalette.questionnaireId, body.questionnaireId))
      );
      dbTime += deleteTime;

      // Insert new palettes
      const [rows, insertTime] = await measureAsync(() =>
        db
          .insert(brandPalette)
          .values(
            palettes.map((p) => ({
              questionnaireId: body.questionnaireId as string,
              name: p.name,
              colors: p.colors,
              selected: false,
            }))
          )
          .returning()
      );
      dbTime += insertTime;

      return jsonWithTimings(
        {
          palettes: rows.map((r, i) => ({
            id: r.id,
            name: r.name,
            colors: palettes[i]!.colors,
          })),
        },
        {
          timings: [
            { name: "db", duration: dbTime, description: "Database queries" },
            { name: "generate", duration: genTime, description: "Palette generation" },
          ],
        }
      );
    }

    // No persistence — just return generated palettes
    return jsonWithTimings(
      { palettes },
      {
        timings: [
          { name: "generate", duration: genTime, description: "Palette generation" },
        ],
      }
    );
  } catch {
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
});
