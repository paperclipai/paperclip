import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { brandQuestionnaire, brandPalette } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generatePalettes } from "@/lib/palette";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    let industry: string;
    let personality: string[];

    if (body.questionnaireId) {
      // Load from DB
      const [q] = await db
        .select()
        .from(brandQuestionnaire)
        .where(eq(brandQuestionnaire.id, body.questionnaireId))
        .limit(1);

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

    const palettes = generatePalettes(industry, personality, 4);

    // Persist generated palettes if we have a questionnaire ID
    if (body.questionnaireId) {
      // Remove any previously generated (unselected) palettes for this questionnaire
      await db
        .delete(brandPalette)
        .where(eq(brandPalette.questionnaireId, body.questionnaireId));

      // Insert new palettes
      const rows = await db
        .insert(brandPalette)
        .values(
          palettes.map((p) => ({
            questionnaireId: body.questionnaireId as string,
            name: p.name,
            colors: p.colors,
            selected: false,
          }))
        )
        .returning();

      return NextResponse.json({
        palettes: rows.map((r, i) => ({
          id: r.id,
          name: r.name,
          colors: palettes[i]!.colors,
        })),
      });
    }

    // No persistence — just return generated palettes
    return NextResponse.json({ palettes });
  } catch {
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
