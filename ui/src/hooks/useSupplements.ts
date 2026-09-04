import { useQuery } from "@tanstack/react-query";

export interface SupplementIntake {
  id: string;
  name: string;
  dose: string;
  unit: string;
  scheduledAt: string;
  takenAt: string | null;
}

export interface SupplementsIntakeResult {
  date: string;
  intakes: SupplementIntake[];
}

export function formatIntakeDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildSupplementsIntakeUrl(apiUrl: string, date: string): string {
  return `${apiUrl}/supplements/intake/${date}`;
}

const apiUrl = import.meta.env.VITE_API_URL as string | undefined;

async function fetchSupplementsIntake(date: string): Promise<SupplementsIntakeResult> {
  if (!apiUrl) {
    return { date, intakes: [] };
  }

  const res = await fetch(buildSupplementsIntakeUrl(apiUrl, date), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to load supplements intake (${res.status})`);
  }

  return res.json() as Promise<SupplementsIntakeResult>;
}

export function useSupplementsIntake(date?: string) {
  const targetDate = date ?? formatIntakeDate(new Date());
  return useQuery({
    queryKey: ["supplements-intake", targetDate],
    queryFn: () => fetchSupplementsIntake(targetDate),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSupplements() {
  return useSupplementsIntake();
}
