import { z } from "zod";
import {
  RT2_GRAPH_CONFIDENCES,
  RT2_GRAPH_EDGE_TYPES,
  RT2_GRAPH_NODE_TYPES,
} from "../constants.js";

export const rt2GraphNodeTypeSchema = z.enum(RT2_GRAPH_NODE_TYPES);
export const rt2GraphEdgeTypeSchema = z.enum(RT2_GRAPH_EDGE_TYPES);
export const rt2GraphConfidenceSchema = z.enum(RT2_GRAPH_CONFIDENCES);

export const listRt2ProjectGraphSchema = z.object({
  projectId: z.string().uuid(),
});

export type ListRt2ProjectGraph = z.infer<typeof listRt2ProjectGraphSchema>;
