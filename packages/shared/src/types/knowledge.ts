export interface KnowledgeDocument {
  id: string;
  companyId: string;
  title: string;
  category: string | null;
  tags: string[];
  content: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeContextDocument {
  id: string;
  title: string;
  category: string | null;
  tags: string[];
  content: string;
  truncated: boolean;
  updatedAt: Date;
}