import { pgTable, uuid, varchar, timestamp, text, jsonb, integer, boolean } from "drizzle-orm/pg-core";

export const waitlist = pgTable("waitlist", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const brandQuestionnaire = pgTable("brand_questionnaire", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Step 1: Business basics
  businessName: varchar("business_name", { length: 200 }),
  industry: varchar("industry", { length: 200 }),
  businessDescription: text("business_description"),
  // Step 2: Target audience
  targetAudience: text("target_audience"),
  // Step 3: Brand personality (stored as JSON array of adjectives)
  brandPersonality: jsonb("brand_personality").$type<string[]>(),
  // Step 4: Inspiration
  competitors: text("competitors"),
  visualPreferences: text("visual_preferences"),
  // Progress tracking
  currentStep: integer("current_step").default(1).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const brandPalette = pgTable("brand_palette", {
  id: uuid("id").defaultRandom().primaryKey(),
  questionnaireId: uuid("questionnaire_id")
    .notNull()
    .references(() => brandQuestionnaire.id),
  name: varchar("name", { length: 100 }).notNull(),
  colors: jsonb("colors")
    .$type<
      { role: string; hex: string; hsl: { h: number; s: number; l: number } }[]
    >()
    .notNull(),
  selected: boolean("selected").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
