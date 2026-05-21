import type { Testimonial, TestimonialInput, UpdateTestimonialInput } from "@paperclipai/shared";
import { api } from "./client";

export const testimonialsApi = {
  list: (companyId: string) =>
    api.get<Testimonial[]>(`/companies/${companyId}/testimonials`),

  get: (companyId: string, id: string) =>
    api.get<Testimonial>(`/companies/${companyId}/testimonials/${id}`),

  create: (companyId: string, data: TestimonialInput) =>
    api.post<Testimonial>(`/companies/${companyId}/testimonials`, data),

  update: (companyId: string, id: string, data: UpdateTestimonialInput) =>
    api.put<Testimonial>(`/companies/${companyId}/testimonials/${id}`, data),

  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/testimonials/${id}`),
};
