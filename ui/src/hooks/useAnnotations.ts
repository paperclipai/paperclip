import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  type Annotation,
  type CreateAnnotationInput,
  type UpdateAnnotationInput,
} from "../api/annotations";

export type { Annotation, AnnotationType, AnnotationSeverity, AnnotationVisibility, GeoJsonGeometry } from "../api/annotations";

export function useAnnotations(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ["annotations", companyId],
    queryFn: () => fetchAnnotations(companyId!),
    enabled: !!companyId,
    staleTime: 5_000,
    refetchInterval: 5_000,
    select: (data) => data.annotations,
  });
}

export function useCreateAnnotation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAnnotationInput) => createAnnotation(input),
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["annotations", input.companyId] });
    },
  });
}

export function useUpdateAnnotation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; companyId: string; updates: UpdateAnnotationInput }) =>
      updateAnnotation(id, updates),
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["annotations", companyId] });
    },
  });
}

export function useDeleteAnnotation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; companyId: string }) => deleteAnnotation(id),
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["annotations", companyId] });
    },
  });
}
