import { z } from "zod";
import {
  RT2_CORPUS_GRAPH_EDGE_TYPES,
  RT2_CORPUS_GRAPH_NODE_TYPES,
  RT2_CORPUS_GRAPH_SOURCE_TYPES,
  RT2_GRAPH_CONFIDENCES,
  RT2_GRAPH_EDGE_TYPES,
  RT2_GRAPH_NODE_TYPES,
} from "../constants.js";

export const rt2GraphNodeTypeSchema = z.enum(RT2_GRAPH_NODE_TYPES);
export const rt2GraphEdgeTypeSchema = z.enum(RT2_GRAPH_EDGE_TYPES);
export const rt2GraphConfidenceSchema = z.enum(RT2_GRAPH_CONFIDENCES);
export const rt2CorpusGraphSourceTypeSchema = z.enum(RT2_CORPUS_GRAPH_SOURCE_TYPES);
export const rt2CorpusGraphNodeTypeSchema = z.enum(RT2_CORPUS_GRAPH_NODE_TYPES);
export const rt2CorpusGraphEdgeTypeSchema = z.enum(RT2_CORPUS_GRAPH_EDGE_TYPES);

export const rt2CorpusGraphSourceLocationSchema = z.object({
  path: z.string().min(1).max(1_000),
  url: z.string().url().nullable().optional(),
  startLine: z.coerce.number().int().positive().nullable().optional(),
  endLine: z.coerce.number().int().positive().nullable().optional(),
  section: z.string().min(1).max(500).nullable().optional(),
});

const corpusMetadataSchema = z.record(z.string(), z.unknown());

export const ingestRt2CorpusGraphSchema = z.object({
  sources: z.array(z.object({
    sourceKey: z.string().min(1).max(500),
    sourceType: rt2CorpusGraphSourceTypeSchema,
    content: z.string().min(1).max(200_000),
    title: z.string().min(1).max(500).optional(),
    sourceLocation: rt2CorpusGraphSourceLocationSchema.partial().optional(),
    metadata: corpusMetadataSchema.optional(),
  })).min(1).max(50),
  rebuildReport: z.boolean().optional().default(true),
});

export const getRt2CorpusGraphNodeSchema = z.object({
  nodeKey: z.string().min(1).max(500),
});

export const listRt2CorpusGraphNeighborsSchema = z.object({
  nodeKey: z.string().min(1).max(500),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export const getRt2CorpusGraphCommunitySchema = z.object({
  communityKey: z.string().min(1).max(200),
});

export const getRt2CorpusGraphShortestPathSchema = z.object({
  fromNodeKey: z.string().min(1).max(500),
  toNodeKey: z.string().min(1).max(500),
  maxDepth: z.coerce.number().int().positive().max(20).optional().default(12),
});

export const listRt2ProjectGraphSchema = z.object({
  projectId: z.string().uuid(),
});

export type IngestRt2CorpusGraph = z.infer<typeof ingestRt2CorpusGraphSchema>;
export type GetRt2CorpusGraphNode = z.infer<typeof getRt2CorpusGraphNodeSchema>;
export type ListRt2CorpusGraphNeighbors = z.infer<typeof listRt2CorpusGraphNeighborsSchema>;
export type GetRt2CorpusGraphCommunity = z.infer<typeof getRt2CorpusGraphCommunitySchema>;
export type GetRt2CorpusGraphShortestPath = z.infer<typeof getRt2CorpusGraphShortestPathSchema>;
export type ListRt2ProjectGraph = z.infer<typeof listRt2ProjectGraphSchema>;
