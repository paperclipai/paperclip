export interface Testimonial {
  id: string;
  companyId: string;
  authorName: string;
  authorRole: string | null;
  authorAvatarUrl: string | null;
  content: string;
  rating: number | null;
  sortOrder: number;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}
