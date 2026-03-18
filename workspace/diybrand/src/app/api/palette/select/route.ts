import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { brandPalette } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(request: NextRequest) {
  try {
    const { paletteId, questionnaireId } = await request.json();

    if (!paletteId || !questionnaireId) {
      return NextResponse.json(
        { error: "paletteId and questionnaireId are required" },
        { status: 400 }
      );
    }

    // Deselect all palettes for this questionnaire
    await db
      .update(brandPalette)
      .set({ selected: false })
      .where(eq(brandPalette.questionnaireId, questionnaireId));

    // Select the chosen one
    const [row] = await db
      .update(brandPalette)
      .set({ selected: true })
      .where(
        and(
          eq(brandPalette.id, paletteId),
          eq(brandPalette.questionnaireId, questionnaireId)
        )
      )
      .returning();

    if (!row) {
      return NextResponse.json({ error: "Palette not found" }, { status: 404 });
    }

    return NextResponse.json(row);
  } catch {
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
