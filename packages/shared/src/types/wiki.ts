export interface WikiContextBundle {
  indexPage: string;
  learningsPage: string;
  projectPage: string | null;
  projectSlug: string | null;
  wikiPath: string;
}

export interface WikiUpdate {
  action: "upsert" | "delete";
  path: string;
  content?: string;
}

export interface WikiPageInfo {
  path: string;
  title: string;
  sizeBytes: number;
  updatedAt: string;
}
