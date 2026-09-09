export type AnnotationType = "perimeter" | "hazard" | "resource" | "note";
export type AnnotationSeverity = "critical" | "warning" | "info";
export type AnnotationVisibility = "org_wide" | "admin_only";

export interface GeoJsonGeometry {
  type: "Point" | "LineString" | "Polygon";
  coordinates: number[] | number[][] | number[][][];
}

export interface Annotation {
  id: string;
  companyId: string;
  authorId: string;
  authorName: string | null;
  label: string;
  annotationType: AnnotationType;
  severity: AnnotationSeverity;
  visibility: AnnotationVisibility;
  geometry: GeoJsonGeometry;
  irwinIncidentId: string | null;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationsResponse {
  annotations: Annotation[];
}

export interface CreateAnnotationInput {
  companyId: string;
  label: string;
  annotationType: AnnotationType;
  severity: AnnotationSeverity;
  visibility: AnnotationVisibility;
  geometry: GeoJsonGeometry;
  authorName?: string;
  irwinIncidentId?: string | null;
}

export interface UpdateAnnotationInput {
  label?: string;
  annotationType?: AnnotationType;
  severity?: AnnotationSeverity;
  visibility?: AnnotationVisibility;
  geometry?: GeoJsonGeometry;
}

export async function fetchAnnotations(companyId: string): Promise<AnnotationsResponse> {
  const url = new URL("/api/annotations", window.location.origin);
  url.searchParams.set("companyId", companyId);
  const res = await fetch(url.toString(), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to load annotations (${res.status})`);
  }
  return res.json() as Promise<AnnotationsResponse>;
}

export async function createAnnotation(input: CreateAnnotationInput): Promise<Annotation> {
  const res = await fetch("/api/annotations", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to create annotation (${res.status})`);
  }
  return res.json() as Promise<Annotation>;
}

export async function updateAnnotation(id: string, updates: UpdateAnnotationInput): Promise<Annotation> {
  const res = await fetch(`/api/annotations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to update annotation (${res.status})`);
  }
  return res.json() as Promise<Annotation>;
}

export async function deleteAnnotation(id: string): Promise<void> {
  const res = await fetch(`/api/annotations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to delete annotation (${res.status})`);
  }
}
