"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { StepProgress } from "./StepProgress";
import { StepBusinessBasics } from "./steps/StepBusinessBasics";
import { StepTargetAudience } from "./steps/StepTargetAudience";
import { StepBrandPersonality } from "./steps/StepBrandPersonality";
import { StepInspiration } from "./steps/StepInspiration";
import { StepReview } from "./steps/StepReview";
import { StepPalette } from "./steps/StepPalette";
import { StepTypography } from "./steps/StepTypography";
import { StepLogo } from "./steps/StepLogo";
import { StepExport } from "./steps/StepExport";

export type QuestionnaireData = {
  id?: string;
  businessName: string;
  industry: string;
  businessDescription: string;
  targetAudience: string;
  brandPersonality: string[];
  competitors: string;
  visualPreferences: string;
};

const INITIAL_DATA: QuestionnaireData = {
  businessName: "",
  industry: "",
  businessDescription: "",
  targetAudience: "",
  brandPersonality: [],
  competitors: "",
  visualPreferences: "",
};

const STEP_LABELS = [
  "Business basics",
  "Target audience",
  "Personality",
  "Inspiration",
  "Review",
  "Colors",
  "Typography",
  "Logo",
  "Export",
];

const STORAGE_KEY = "diybrand_questionnaire_id";

function saveSessionId(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage unavailable (SSR, private mode, quota)
  }
}

function loadSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearSessionId() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // noop
  }
}

export function BrandWizard() {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<QuestionnaireData>(INITIAL_DATA);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [recovering, setRecovering] = useState(true);
  const recoveryAttempted = useRef(false);

  // Session recovery: load questionnaire from localStorage on mount
  useEffect(() => {
    if (recoveryAttempted.current) return;
    recoveryAttempted.current = true;

    const savedId = loadSessionId();
    if (!savedId) {
      setRecovering(false);
      return;
    }

    fetch(`/api/questionnaire?id=${encodeURIComponent(savedId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Not found");
        return res.json();
      })
      .then((row) => {
        // Don't recover completed questionnaires
        if (row.completedAt) {
          clearSessionId();
          setRecovering(false);
          return;
        }

        setData({
          id: row.id,
          businessName: row.businessName ?? "",
          industry: row.industry ?? "",
          businessDescription: row.businessDescription ?? "",
          targetAudience: row.targetAudience ?? "",
          brandPersonality: (row.brandPersonality as string[]) ?? [],
          competitors: row.competitors ?? "",
          visualPreferences: row.visualPreferences ?? "",
        });
        // Resume at saved step, but cap at step 5 for questionnaire steps
        // (generation steps 6+ need re-entry through the flow)
        const resumeStep = Math.min(row.currentStep ?? 1, 9);
        setStep(resumeStep);
        setRecovering(false);
      })
      .catch(() => {
        // Stale or invalid session — clear and start fresh
        clearSessionId();
        setRecovering(false);
      });
  }, []);

  const updateData = useCallback((partial: Partial<QuestionnaireData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  const saveProgress = useCallback(
    async (nextStep: number, complete = false) => {
      setSaving(true);
      try {
        const method = data.id ? "PUT" : "POST";
        const body = {
          ...(data.id ? { id: data.id } : {}),
          businessName: data.businessName || null,
          industry: data.industry || null,
          businessDescription: data.businessDescription || null,
          targetAudience: data.targetAudience || null,
          brandPersonality: data.brandPersonality.length > 0 ? data.brandPersonality : null,
          competitors: data.competitors || null,
          visualPreferences: data.visualPreferences || null,
          currentStep: nextStep,
          ...(complete ? { completedAt: new Date().toISOString() } : {}),
        };

        const res = await fetch("/api/questionnaire", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) throw new Error("Save failed");

        const saved = await res.json();
        if (!data.id && saved.id) {
          setData((prev) => ({ ...prev, id: saved.id }));
          saveSessionId(saved.id);
        }
      } catch {
        // Silently continue — user can still navigate
      } finally {
        setSaving(false);
      }
    },
    [data]
  );

  // Persist questionnaireId to localStorage whenever it changes
  useEffect(() => {
    if (data.id) saveSessionId(data.id);
  }, [data.id]);

  const validateStep = useCallback(
    (s: number): boolean => {
      const errs: Record<string, string> = {};

      if (s === 1) {
        if (!data.businessName.trim()) errs.businessName = "Business name is required";
        if (!data.industry.trim()) errs.industry = "Industry is required";
        if (!data.businessDescription.trim())
          errs.businessDescription = "A brief description is required";
      }

      if (s === 2) {
        if (!data.targetAudience.trim())
          errs.targetAudience = "Please describe your target audience";
      }

      if (s === 3) {
        if (data.brandPersonality.length < 3)
          errs.brandPersonality = "Select at least 3 adjectives";
        if (data.brandPersonality.length > 5)
          errs.brandPersonality = "Select at most 5 adjectives";
      }

      setErrors(errs);
      return Object.keys(errs).length === 0;
    },
    [data]
  );

  const goNext = useCallback(async () => {
    if (!validateStep(step)) return;
    const nextStep = step + 1;
    await saveProgress(nextStep);
    setStep(nextStep);
    setErrors({});
  }, [step, validateStep, saveProgress]);

  const goBack = useCallback(() => {
    setStep((s) => Math.max(1, s - 1));
    setErrors({});
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!validateStep(step)) return;
    setSaving(true);
    try {
      const method = data.id ? "PUT" : "POST";
      const body = {
        ...(data.id ? { id: data.id } : {}),
        businessName: data.businessName || null,
        industry: data.industry || null,
        businessDescription: data.businessDescription || null,
        targetAudience: data.targetAudience || null,
        brandPersonality: data.brandPersonality.length > 0 ? data.brandPersonality : null,
        competitors: data.competitors || null,
        visualPreferences: data.visualPreferences || null,
        currentStep: 6,
      };

      const res = await fetch("/api/questionnaire", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Save failed");

      const saved = await res.json();
      if (!data.id && saved.id) {
        setData((prev) => ({ ...prev, id: saved.id }));
        saveSessionId(saved.id);
      }
      setStep(6);
    } catch {
      setErrors({ submit: "Could not save your answers. Please try again." });
    } finally {
      setSaving(false);
    }
  }, [step, validateStep, data]);

  if (recovering) {
    return (
      <div className="glass neon-glow rounded-2xl p-6 sm:p-8">
        <div className="flex flex-col items-center justify-center py-12" role="status" aria-busy="true">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/10 border-t-[var(--accent-cyan)]" aria-hidden="true" />
          <p className="mt-3 text-sm" style={{ color: "var(--text-muted)" }}>Restoring your session...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="glass neon-glow rounded-2xl p-6 sm:p-8">
      <StepProgress currentStep={step} labels={STEP_LABELS} />

      <div className="mt-8" aria-live="polite" aria-atomic="true">
        {step === 1 && (
          <StepBusinessBasics data={data} updateData={updateData} errors={errors} />
        )}
        {step === 2 && (
          <StepTargetAudience data={data} updateData={updateData} errors={errors} />
        )}
        {step === 3 && (
          <StepBrandPersonality data={data} updateData={updateData} errors={errors} />
        )}
        {step === 4 && (
          <StepInspiration data={data} updateData={updateData} />
        )}
        {step === 5 && <StepReview data={data} />}
        {step >= 6 && !data.id && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-6 text-center" role="alert">
            <p className="text-sm text-red-400">
              {errors.submit || "Something went wrong saving your answers."}
            </p>
            <button
              type="button"
              onClick={() => setStep(5)}
              className="cta-glow mt-4 rounded-lg bg-[var(--primary)] px-5 py-2 text-sm font-semibold text-white hover:brightness-110"
            >
              Go back and retry
            </button>
          </div>
        )}
        {step === 6 && data.id && (
          <StepPalette
            questionnaireId={data.id}
            onComplete={() => {
              saveProgress(7);
              setStep(7);
            }}
          />
        )}
        {step === 7 && data.id && (
          <StepTypography
            questionnaireId={data.id}
            onComplete={() => {
              saveProgress(8);
              setStep(8);
            }}
          />
        )}
        {step === 8 && data.id && (
          <StepLogo
            questionnaireId={data.id}
            onComplete={() => {
              saveProgress(9);
              setStep(9);
            }}
          />
        )}
        {step === 9 && data.id && (
          <StepExport
            questionnaireId={data.id}
            brandName={data.businessName || "Brand"}
          />
        )}
      </div>

      {/* Navigation for questionnaire steps 1-5 */}
      {step <= 5 && (
        <div className="mt-8 flex items-center justify-between border-t border-white/10 pt-6">
          {step > 1 ? (
            <button
              type="button"
              onClick={goBack}
              className="rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] hover:border-white/40 hover:bg-white/5 transition-all"
            >
              Back
            </button>
          ) : (
            <div />
          )}

          {step < 5 ? (
            <button
              type="button"
              onClick={goNext}
              disabled={saving}
              className="cta-glow rounded-lg bg-[var(--primary)] px-6 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50 transition-all"
            >
              {saving ? "Saving..." : "Continue"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              className="cta-glow rounded-lg bg-[var(--primary)] px-6 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50 transition-all"
            >
              {saving ? "Submitting..." : "Generate palettes"}
            </button>
          )}
        </div>
      )}

      {/* Back button for generation steps 6-9 */}
      {step >= 6 && (
        <div className="mt-8 flex items-center justify-between border-t border-white/10 pt-6">
          <button
            type="button"
            onClick={goBack}
            className="rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] hover:border-white/40 hover:bg-white/5 transition-all"
          >
            Back
          </button>
          <div />
        </div>
      )}
    </div>
  );
}
