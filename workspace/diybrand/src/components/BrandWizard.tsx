"use client";

import { useState, useCallback } from "react";
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

export function BrandWizard() {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<QuestionnaireData>(INITIAL_DATA);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

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
        }
      } catch {
        // Silently continue — user can still navigate
      } finally {
        setSaving(false);
      }
    },
    [data]
  );

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
    await saveProgress(6);
    setStep(6);
  }, [step, validateStep, saveProgress]);

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-200 sm:p-8">
      <StepProgress currentStep={step} labels={STEP_LABELS} />

      <div className="mt-8">
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

      {step <= 5 && (
        <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-6">
          {step > 1 ? (
            <button
              type="button"
              onClick={goBack}
              className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
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
              className="rounded-lg bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Continue"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              className="rounded-lg bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? "Submitting..." : "Generate palettes"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
