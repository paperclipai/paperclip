import { api } from "./client";

export interface RoadmapLink {
  label: string;
  path: string;
}

export interface RoadmapItemField {
  key: string;
  value: string;
}

export interface RoadmapItem {
  id: string;
  title: string;
  fields: RoadmapItemField[];
}

export interface RoadmapSection {
  title: string;
  items: RoadmapItem[];
}

export interface RoadmapDocument {
  label: string;
  path: string;
  title: string;
  status: string | null;
  owner: string | null;
  lastUpdated: string | null;
  contract: string[];
  sections: RoadmapSection[];
  markdown: string;
}

export interface RoadmapPayload {
  index: {
    path: string;
    markdown: string;
    links: RoadmapLink[];
  };
  roadmap: RoadmapDocument;
}

export const roadmapApi = {
  get: () => api.get<RoadmapPayload>("/roadmap"),
};
