"use client";

import { useState, useRef, useEffect } from "react";
import type { QuestionnaireData } from "../BrandWizard";

type Props = {
  data: QuestionnaireData;
  updateData: (partial: Partial<QuestionnaireData>) => void;
  errors: Record<string, string>;
};

const INDUSTRIES = [
  "Technology",
  "E-commerce",
  "Food & Beverage",
  "Health & Wellness",
  "Education",
  "Finance",
  "Creative & Design",
  "Real Estate",
  "Fashion & Apparel",
  "Travel & Hospitality",
  "Entertainment",
  "Consulting",
  "Non-profit",
  "Other",
];

const inputBase =
  "mt-1.5 block w-full rounded-lg border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-[var(--text-primary)] shadow-sm placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[var(--primary)] focus:border-[var(--primary)] transition-colors";
const inputError = "border-red-400/60";

function IndustryDropdown({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const options = ["", ...INDUSTRIES];
  const selectedIndex = options.indexOf(value);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (open && highlightIndex >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIndex] as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex, open]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setHighlightIndex(Math.max(0, selectedIndex));
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIndex((prev) => Math.min(prev + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (highlightIndex >= 0) {
          onChange(options[highlightIndex]);
          setOpen(false);
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls="industry-listbox"
        aria-invalid={!!error}
        aria-describedby={error ? "industry-error" : undefined}
        onClick={() => {
          setOpen(!open);
          if (!open) setHighlightIndex(Math.max(0, selectedIndex));
        }}
        onKeyDown={handleKeyDown}
        className={`${inputBase} ${error ? inputError : ""} ${!value ? "text-white/30" : ""} flex items-center justify-between text-left cursor-pointer`}
      >
        <span>{value || "Select an industry"}</span>
        <svg
          className={`h-4 w-4 text-white/40 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          id="industry-listbox"
          role="listbox"
          aria-label="Industry"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-white/10 bg-[var(--bg-card)] shadow-lg shadow-black/40 backdrop-blur-sm"
        >
          {options.map((opt, i) => {
            const isSelected = opt === value;
            const isHighlighted = i === highlightIndex;
            const label = opt || "Select an industry";
            return (
              <li
                key={opt}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setHighlightIndex(i)}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`cursor-pointer px-3.5 py-2.5 text-sm transition-colors ${
                  isHighlighted
                    ? "bg-[var(--primary)]/20 text-[var(--text-primary)]"
                    : isSelected
                      ? "bg-white/5 text-[var(--text-primary)]"
                      : "text-[var(--text-primary)]"
                } ${i === 0 ? "text-white/30" : ""} hover:bg-[var(--primary)]/20`}
              >
                {label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function StepBusinessBasics({ data, updateData, errors }: Props) {
  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="businessName" className="block text-sm font-medium text-[var(--text-primary)]">
          Business name
        </label>
        <input
          id="businessName"
          type="text"
          value={data.businessName}
          onChange={(e) => updateData({ businessName: e.target.value })}
          placeholder="e.g. Sunrise Coffee Co."
          aria-invalid={!!errors.businessName}
          aria-describedby={errors.businessName ? "businessName-error" : undefined}
          className={`${inputBase} ${errors.businessName ? inputError : ""}`}
        />
        {errors.businessName && (
          <p id="businessName-error" className="mt-1 text-sm text-[var(--accent-pink)]" role="alert">{errors.businessName}</p>
        )}
      </div>

      <div>
        <label htmlFor="industry" className="block text-sm font-medium text-[var(--text-primary)]">
          Industry
        </label>
        <IndustryDropdown
          value={data.industry}
          onChange={(v) => updateData({ industry: v })}
          error={errors.industry}
        />
        {errors.industry && (
          <p id="industry-error" className="mt-1 text-sm text-[var(--accent-pink)]" role="alert">{errors.industry}</p>
        )}
      </div>

      <div>
        <label htmlFor="businessDescription" className="block text-sm font-medium text-[var(--text-primary)]">
          Describe your business in a few sentences
        </label>
        <textarea
          id="businessDescription"
          value={data.businessDescription}
          onChange={(e) => updateData({ businessDescription: e.target.value })}
          rows={3}
          placeholder="What do you do? What makes you different?"
          aria-invalid={!!errors.businessDescription}
          aria-describedby={errors.businessDescription ? "businessDescription-error" : undefined}
          className={`${inputBase} ${errors.businessDescription ? inputError : ""}`}
        />
        {errors.businessDescription && (
          <p id="businessDescription-error" className="mt-1 text-sm text-[var(--accent-pink)]" role="alert">{errors.businessDescription}</p>
        )}
      </div>
    </div>
  );
}
