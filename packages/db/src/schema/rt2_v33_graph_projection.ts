import { boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const rt2V33GraphNodes = pgTable(
  "rt2_v33_graph_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    nodeKey: text("node_key").notNull(),
    nodeType: text("node_type").notNull(),
    sourceId: text("source_id").notNull(),
    label: text("label").notNull(),
    reportDate: date("report_date"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    centrality: numeric("centrality", { precision: 8, scale: 6 }).notNull().default("0"),
    isGodNode: boolean("is_god_node").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectTypeIdx: index("rt2_v33_graph_nodes_company_project_type_idx").on(
      table.companyId,
      table.projectId,
      table.nodeType,
    ),
    companyNodeKeyUq: uniqueIndex("rt2_v33_graph_nodes_company_node_key_uq").on(table.companyId, table.nodeKey),
  }),
);

export const rt2V33GraphEdges = pgTable(
  "rt2_v33_graph_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sourceNodeId: uuid("source_node_id").notNull().references(() => rt2V33GraphNodes.id, { onDelete: "cascade" }),
    targetNodeId: uuid("target_node_id").notNull().references(() => rt2V33GraphNodes.id, { onDelete: "cascade" }),
    edgeType: text("edge_type").notNull(),
    confidence: text("confidence").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 4, scale: 2 }),
    rationale: text("rationale").notNull(),
    evidence: jsonb("evidence").$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectSourceIdx: index("rt2_v33_graph_edges_company_project_source_idx").on(
      table.companyId,
      table.projectId,
      table.sourceNodeId,
    ),
    companyProjectTargetIdx: index("rt2_v33_graph_edges_company_project_target_idx").on(
      table.companyId,
      table.projectId,
      table.targetNodeId,
    ),
    companyEdgeUq: uniqueIndex("rt2_v33_graph_edges_company_edge_uq").on(
      table.companyId,
      table.projectId,
      table.sourceNodeId,
      table.targetNodeId,
      table.edgeType,
    ),
  }),
);

export const rt2V33GraphCache = pgTable("rt2_v33_graph_cache", {
  scopeKey: text("scope_key").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  inputHash: text("input_hash").notNull(),
  inputWindow: jsonb("input_window").$type<Record<string, unknown>>().notNull().default({}),
  lastProjectedAt: timestamp("last_projected_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rt2V33GraphCommunities = pgTable(
  "rt2_v33_graph_communities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    communityKey: text("community_key").notNull(),
    algorithm: text("algorithm").notNull(),
    label: text("label").notNull(),
    memberNodeCount: integer("member_node_count").notNull().default(0),
    godNodeId: uuid("god_node_id").references(() => rt2V33GraphNodes.id, { onDelete: "set null" }),
    reportPath: text("report_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("rt2_v33_graph_communities_company_project_idx").on(
      table.companyId,
      table.projectId,
    ),
    companyCommunityUq: uniqueIndex("rt2_v33_graph_communities_company_community_uq").on(
      table.companyId,
      table.projectId,
      table.communityKey,
    ),
  }),
);

export const rt2V33GraphReports = pgTable(
  "rt2_v33_graph_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    nodeCount: integer("node_count").notNull().default(0),
    edgeCount: integer("edge_count").notNull().default(0),
    confidenceSummary: jsonb("confidence_summary").$type<Record<string, number>>().notNull().default({
      EXTRACTED: 0,
      INFERRED: 0,
      AMBIGUOUS: 0,
    }),
    centralTaskNodeIds: jsonb("central_task_node_ids").$type<string[]>().notNull().default([]),
    ambiguousEdges: jsonb("ambiguous_edges").$type<Array<Record<string, unknown>>>().notNull().default([]),
    markdown: text("markdown").notNull().default(""),
    communityCount: integer("community_count").notNull().default(0),
    godNodeCount: integer("god_node_count").notNull().default(0),
    surprisingConnectionCount: integer("surprising_connection_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectUq: uniqueIndex("rt2_v33_graph_reports_company_project_uq").on(
      table.companyId,
      table.projectId,
    ),
  }),
);

export const rt2V33SurprisingConnections = pgTable(
  "rt2_v33_surprising_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    nodeAId: uuid("node_a_id").notNull().references(() => rt2V33GraphNodes.id, { onDelete: "cascade" }),
    nodeBId: uuid("node_b_id").notNull().references(() => rt2V33GraphNodes.id, { onDelete: "cascade" }),
    connectionType: text("connection_type").notNull(),
    strength: numeric("strength", { precision: 4, scale: 2 }).notNull().default("0"),
    rationale: text("rationale").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("rt2_v33_surprising_connections_company_project_idx").on(
      table.companyId,
      table.projectId,
    ),
    companyPairUq: uniqueIndex("rt2_v33_surprising_connections_company_pair_uq").on(
      table.companyId,
      table.projectId,
      table.nodeAId,
      table.nodeBId,
    ),
  }),
);

export const rt2V33CorpusGraphSources = pgTable(
  "rt2_v33_corpus_graph_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    sourceType: text("source_type").notNull(),
    sourceLocation: jsonb("source_location").$type<Record<string, unknown>>().notNull().default({}),
    sha256: text("sha256").notNull(),
    title: text("title").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeIdx: index("rt2_v33_corpus_graph_sources_company_type_idx").on(table.companyId, table.sourceType),
    companySourceKeyUq: uniqueIndex("rt2_v33_corpus_graph_sources_company_source_key_uq").on(
      table.companyId,
      table.sourceKey,
    ),
  }),
);

export const rt2V33CorpusGraphNodes = pgTable(
  "rt2_v33_corpus_graph_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    nodeKey: text("node_key").notNull(),
    nodeType: text("node_type").notNull(),
    label: text("label").notNull(),
    sourceId: uuid("source_id").references(() => rt2V33CorpusGraphSources.id, { onDelete: "set null" }),
    sourceLocation: jsonb("source_location").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    centrality: numeric("centrality", { precision: 8, scale: 6 }).notNull().default("0"),
    communityKey: text("community_key"),
    isGodNode: boolean("is_god_node").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeIdx: index("rt2_v33_corpus_graph_nodes_company_type_idx").on(table.companyId, table.nodeType),
    companyCommunityIdx: index("rt2_v33_corpus_graph_nodes_company_community_idx").on(
      table.companyId,
      table.communityKey,
    ),
    companyNodeKeyUq: uniqueIndex("rt2_v33_corpus_graph_nodes_company_node_key_uq").on(
      table.companyId,
      table.nodeKey,
    ),
  }),
);

export const rt2V33CorpusGraphEdges = pgTable(
  "rt2_v33_corpus_graph_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceNodeId: uuid("source_node_id")
      .notNull()
      .references(() => rt2V33CorpusGraphNodes.id, { onDelete: "cascade" }),
    targetNodeId: uuid("target_node_id")
      .notNull()
      .references(() => rt2V33CorpusGraphNodes.id, { onDelete: "cascade" }),
    edgeType: text("edge_type").notNull(),
    relation: text("relation").notNull(),
    confidence: text("confidence").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 4, scale: 2 }),
    rationale: text("rationale").notNull(),
    evidence: jsonb("evidence").$type<Array<Record<string, unknown>>>().notNull().default([]),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceIdx: index("rt2_v33_corpus_graph_edges_company_source_idx").on(
      table.companyId,
      table.sourceNodeId,
    ),
    companyTargetIdx: index("rt2_v33_corpus_graph_edges_company_target_idx").on(
      table.companyId,
      table.targetNodeId,
    ),
    companyEdgeUq: uniqueIndex("rt2_v33_corpus_graph_edges_company_edge_uq").on(
      table.companyId,
      table.sourceNodeId,
      table.targetNodeId,
      table.edgeType,
      table.relation,
    ),
  }),
);

export const rt2V33CorpusGraphCommunities = pgTable(
  "rt2_v33_corpus_graph_communities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    communityKey: text("community_key").notNull(),
    algorithm: text("algorithm").notNull(),
    label: text("label").notNull(),
    memberNodeCount: integer("member_node_count").notNull().default(0),
    godNodeId: uuid("god_node_id").references(() => rt2V33CorpusGraphNodes.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("rt2_v33_corpus_graph_communities_company_idx").on(table.companyId),
    companyCommunityUq: uniqueIndex("rt2_v33_corpus_graph_communities_company_community_uq").on(
      table.companyId,
      table.communityKey,
    ),
  }),
);

export const rt2V33CorpusGraphReports = pgTable(
  "rt2_v33_corpus_graph_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    corpusNodeCount: integer("corpus_node_count").notNull().default(0),
    corpusEdgeCount: integer("corpus_edge_count").notNull().default(0),
    productNodeCount: integer("product_node_count").notNull().default(0),
    productEdgeCount: integer("product_edge_count").notNull().default(0),
    confidenceSummary: jsonb("confidence_summary").$type<Record<string, number>>().notNull().default({
      EXTRACTED: 0,
      INFERRED: 0,
      AMBIGUOUS: 0,
    }),
    communityCount: integer("community_count").notNull().default(0),
    godNodeKeys: jsonb("god_node_keys").$type<string[]>().notNull().default([]),
    knowledgeGaps: jsonb("knowledge_gaps").$type<Array<Record<string, unknown>>>().notNull().default([]),
    surprisingConnections: jsonb("surprising_connections").$type<Array<Record<string, unknown>>>().notNull().default([]),
    suggestedQuestions: jsonb("suggested_questions").$type<string[]>().notNull().default([]),
    markdown: text("markdown").notNull().default(""),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("rt2_v33_corpus_graph_reports_company_uq").on(table.companyId),
  }),
);
