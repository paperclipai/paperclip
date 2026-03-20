import { pgTable, uuid, varchar, timestamp, text, jsonb, integer, boolean, index } from "drizzle-orm/pg-core";

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
}, (table) => ({
  questionnaireSelectedIdx: index("brand_palette_questionnaire_selected_idx").on(table.questionnaireId, table.selected),
}));

export const brandTypography = pgTable("brand_typography", {
  id: uuid("id").defaultRandom().primaryKey(),
  questionnaireId: uuid("questionnaire_id")
    .notNull()
    .references(() => brandQuestionnaire.id),
  name: varchar("name", { length: 100 }).notNull(),
  headingFamily: varchar("heading_family", { length: 200 }).notNull(),
  headingWeight: integer("heading_weight").notNull(),
  headingCategory: varchar("heading_category", { length: 50 }).notNull(),
  bodyFamily: varchar("body_family", { length: 200 }).notNull(),
  bodyWeight: integer("body_weight").notNull(),
  bodyCategory: varchar("body_category", { length: 50 }).notNull(),
  selected: boolean("selected").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  questionnaireSelectedIdx: index("brand_typography_questionnaire_selected_idx").on(table.questionnaireId, table.selected),
}));

export const brandLogos = pgTable("brand_logos", {
  id: uuid("id").defaultRandom().primaryKey(),
  questionnaireId: uuid("questionnaire_id")
    .notNull()
    .references(() => brandQuestionnaire.id),
  name: varchar("name", { length: 100 }).notNull(),
  variant: varchar("variant", { length: 50 }).notNull(), // "wordmark" | "icon"
  imageData: text("image_data"), // deprecated: base64 data URI (nullable for migration)
  imagePath: varchar("image_path", { length: 500 }), // file path relative to uploads dir
  mimeType: varchar("mime_type", { length: 100 }), // e.g. "image/png"
  prompt: text("prompt").notNull(),
  selected: boolean("selected").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  questionnaireSelectedIdx: index("brand_logos_questionnaire_selected_idx").on(table.questionnaireId, table.selected),
}));

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  stripeSessionId: varchar("stripe_session_id", { length: 255 }).notNull().unique(),
  tier: varchar("tier", { length: 20 }).notNull(), // "basic" | "premium"
  paidAt: timestamp("paid_at", { withTimezone: true }),
  questionnaireId: uuid("questionnaire_id")
    .notNull()
    .references(() => brandQuestionnaire.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  questionnaireIdx: index("orders_questionnaire_idx").on(table.questionnaireId),
}));

export const feedback = pgTable("feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  rating: integer("rating").notNull(), // 1-5
  text: text("text"), // Optional feedback comment (max 1000 chars enforced in API)
  userAgent: varchar("user_agent", { length: 500 }),
  referrer: varchar("referrer", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  ratingIdx: index("feedback_rating_idx").on(table.rating),
  createdIdx: index("feedback_created_idx").on(table.createdAt),
}));
