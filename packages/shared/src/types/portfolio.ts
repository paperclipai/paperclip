export interface PortfolioItem {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  category: string | null;
  tags: string[] | null;
  clientName: string | null;
  projectUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  sortOrder: number;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}
