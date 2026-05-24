import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import type {
  BriefingFeedbackRating,
  BriefingFeedbackCategory,
} from "@paperclipai/shared";
import { useBriefingFeedback } from "../useBriefingFeedback.js";

type SheetState = "unrated" | "expanded" | "submitting" | "submitted" | "error";

const RATINGS: { label: string; value: BriefingFeedbackRating }[] = [
  { label: "Yes", value: "yes" },
  { label: "Somewhat", value: "somewhat" },
  { label: "No", value: "no" },
];

const CATEGORIES: { label: string; value: BriefingFeedbackCategory }[] = [
  { label: "Inaccurate Info", value: "inaccurate_info" },
  { label: "Missing Section", value: "missing_section" },
  { label: "Hard to Read", value: "hard_to_read" },
  { label: "Late Delivery", value: "late_delivery" },
  { label: "Other", value: "other" },
];

function generateAnonymousId(): string {
  return `anon-${Math.random().toString(36).substring(2, 10)}-${Date.now().toString(36)}`;
}

interface FeedbackSheetProps {
  visible: boolean;
  briefingId: string;
  apiUrl: string;
  onClose: () => void;
  onSubmitted?: () => void;
}

export function FeedbackSheet({
  visible,
  briefingId,
  apiUrl,
  onClose,
  onSubmitted,
}: FeedbackSheetProps) {
  const { submit, loading } = useBriefingFeedback({ apiUrl });
  const [state, setState] = useState<SheetState>("unrated");
  const [selectedRating, setSelectedRating] = useState<BriefingFeedbackRating | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<BriefingFeedbackCategory | null>(null);
  const [freeText, setFreeText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [draftRating, setDraftRating] = useState<BriefingFeedbackRating | null>(null);
  const [draftCategory, setDraftCategory] = useState<BriefingFeedbackCategory | null>(null);
  const [draftFreeText, setDraftFreeText] = useState("");
  const [deviceId] = useState(generateAnonymousId);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isNo = selectedRating === "no";

  useEffect(() => {
    return () => {
      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };
  }, []);

  const reset = () => {
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    setState("unrated");
    setSelectedRating(null);
    setSelectedCategory(null);
    setFreeText("");
    setError(null);
    setDraftRating(null);
    setDraftCategory(null);
    setDraftFreeText("");
  };

  const handleRatingPress = (rating: BriefingFeedbackRating) => {
    setDraftRating(rating);
    if (rating === "yes") {
      setSelectedRating(rating);
      setState("submitting");
      handleSubmitWithRating(rating);
    } else {
      setSelectedRating(rating);
      setSelectedCategory(null);
      setFreeText("");
      setError(null);
      setState("expanded");
    }
  };

  const handleSubmitWithRating = async (rating: BriefingFeedbackRating) => {
    setError(null);
    setState("submitting");
    try {
      await submit(
        briefingId,
        rating,
        rating === "yes" ? null : selectedCategory,
        rating === "yes" ? null : freeText || null,
        deviceId,
      );
      setState("submitted");
      onSubmitted?.();
      autoDismissRef.current = setTimeout(() => {
        reset();
        onClose();
      }, 4000);
    } catch {
      setState("error");
      setError("Failed to submit feedback. Please try again.");
    }
  };

  const handleSubmit = () => {
    if (!selectedRating) return;

    if (isNo && !selectedCategory) return;

    handleSubmitWithRating(selectedRating);
  };

  const handleChange = () => {
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    reset();
  };

  const handleRetry = () => {
    if (!selectedRating) return;
    handleSubmitWithRating(selectedRating);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const canSubmit = (() => {
    if (!selectedRating) return false;
    if (selectedRating === "yes") return false;
    if (isNo && !selectedCategory) return false;
    return true;
  })();

  const submitDisabled = !canSubmit || loading;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Briefing Feedback</Text>
          <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>Close</Text>
          </TouchableOpacity>
        </View>

        {state === "unrated" && (
          <View style={styles.section}>
            <Text style={styles.label}>Was this briefing helpful?</Text>
            <View style={styles.ratingRow}>
              {RATINGS.map((r) => (
                <TouchableOpacity
                  key={r.value}
                  style={styles.ratingButton}
                  onPress={() => handleRatingPress(r.value)}
                >
                  <Text style={styles.ratingText}>{r.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {state === "expanded" && selectedRating && (
          <>
            <View style={styles.section}>
              <Text style={styles.selectedRatingText}>
                You selected: <Text style={styles.selectedRatingValue}>{RATINGS.find((r) => r.value === selectedRating)?.label}</Text>
              </Text>
              <TouchableOpacity onPress={handleChange}>
                <Text style={styles.changeLink}>Change</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>
                What could be improved?
                {isNo && <Text style={styles.required}> (required)</Text>}
              </Text>
              <View style={styles.categoryRow}>
                {CATEGORIES.map((c) => (
                  <TouchableOpacity
                    key={c.value}
                    style={[
                      styles.categoryButton,
                      selectedCategory === c.value && styles.categoryButtonSelected,
                      isNo && selectedCategory === c.value && styles.categoryButtonDestructive,
                    ]}
                    onPress={() =>
                      setSelectedCategory(selectedCategory === c.value ? null : c.value)
                    }
                  >
                    <Text
                      style={[
                        styles.categoryText,
                        selectedCategory === c.value && styles.categoryTextSelected,
                        isNo && selectedCategory === c.value && styles.categoryTextDestructive,
                      ]}
                    >
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>
                Additional details
                <Text style={styles.optional}> (optional)</Text>
              </Text>
              <TextInput
                style={styles.input}
                value={freeText}
                onChangeText={setFreeText}
                placeholder="Tell us more..."
                placeholderTextColor="#9ca3af"
                multiline
                numberOfLines={4}
                maxLength={5000}
              />
            </View>

            <TouchableOpacity
              style={[
                styles.submitButton,
                isNo && styles.submitButtonDestructive,
                submitDisabled && styles.submitButtonDisabled,
              ]}
              onPress={handleSubmit}
              disabled={submitDisabled}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitButtonText}>
                  {isNo ? "Report Issue" : "Submit Feedback"}
                </Text>
              )}
            </TouchableOpacity>
          </>
        )}

        {state === "submitting" && selectedRating === "yes" && (
          <View style={styles.submittingContainer}>
            <ActivityIndicator size="large" color="#6366f1" />
            <Text style={styles.submittingText}>Submitting your feedback...</Text>
          </View>
        )}

        {state === "submitted" && (
          <View style={styles.submittedContainer}>
            <View style={styles.submittedIconContainer}>
              <Text style={styles.submittedIcon}>✓</Text>
            </View>
            <Text style={styles.submittedTitle}>Feedback Submitted</Text>
            <Text style={styles.submittedDetail}>
              {selectedRating === "yes"
                ? "Glad this briefing was helpful!"
                : selectedRating === "somewhat"
                  ? "Thanks for your feedback — we'll work on improving."
                  : "Thanks for reporting. We'll look into this right away."}
            </Text>
            {selectedCategory && (
              <View style={styles.submittedSummary}>
                <Text style={styles.submittedSummaryLabel}>Category:</Text>
                <Text style={styles.submittedSummaryValue}>
                  {CATEGORIES.find((c) => c.value === selectedCategory)?.label}
                </Text>
              </View>
            )}
            {freeText ? (
              <View style={styles.submittedSummary}>
                <Text style={styles.submittedSummaryLabel}>Comment:</Text>
                <Text style={styles.submittedSummaryValue} numberOfLines={2}>
                  {freeText}
                </Text>
              </View>
            ) : null}
            <TouchableOpacity style={styles.changeButton} onPress={handleChange}>
              <Text style={styles.changeButtonText}>Change Response</Text>
            </TouchableOpacity>
          </View>
        )}

        {state === "error" && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Submission Failed</Text>
            <Text style={styles.errorMessage}>{error}</Text>
            <View style={styles.errorActions}>
              <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.retryButtonText}>Retry</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={styles.discardButton} onPress={handleClose}>
                <Text style={styles.discardButtonText}>Discard</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    padding: 24,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 32,
    paddingTop: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111827",
  },
  closeButton: {
    padding: 8,
  },
  closeButtonText: {
    fontSize: 16,
    color: "#6366f1",
    fontWeight: "600",
  },
  section: {
    marginBottom: 24,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 12,
  },
  required: {
    color: "#ef4444",
    fontWeight: "700",
  },
  optional: {
    color: "#9ca3af",
    fontWeight: "400",
  },
  ratingRow: {
    flexDirection: "row",
    gap: 12,
  },
  ratingButton: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    alignItems: "center",
    backgroundColor: "#f9fafb",
  },
  ratingText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#6b7280",
  },
  selectedRatingText: {
    fontSize: 15,
    color: "#6b7280",
    marginBottom: 8,
  },
  selectedRatingValue: {
    fontWeight: "700",
    color: "#111827",
  },
  changeLink: {
    fontSize: 14,
    color: "#6366f1",
    fontWeight: "600",
  },
  categoryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  categoryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
  },
  categoryButtonSelected: {
    borderColor: "#6366f1",
    backgroundColor: "#eef2ff",
  },
  categoryButtonDestructive: {
    borderColor: "#ef4444",
    backgroundColor: "#fef2f2",
  },
  categoryText: {
    fontSize: 14,
    color: "#6b7280",
  },
  categoryTextSelected: {
    color: "#6366f1",
    fontWeight: "600",
  },
  categoryTextDestructive: {
    color: "#ef4444",
    fontWeight: "600",
  },
  input: {
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    color: "#111827",
    minHeight: 100,
    textAlignVertical: "top",
  },
  inputDestructive: {
    borderColor: "#fca5a5",
    backgroundColor: "#fffbfb",
  },
  submittingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: 80,
  },
  submittingText: {
    marginTop: 16,
    fontSize: 16,
    color: "#6b7280",
  },
  submittedContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 80,
    paddingHorizontal: 24,
  },
  submittedIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#d1fae5",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  submittedIcon: {
    fontSize: 32,
    color: "#059669",
    fontWeight: "700",
  },
  submittedTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 8,
  },
  submittedDetail: {
    fontSize: 15,
    color: "#6b7280",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 24,
  },
  submittedSummary: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 6,
    width: "100%",
  },
  submittedSummaryLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginRight: 8,
  },
  submittedSummaryValue: {
    fontSize: 14,
    color: "#6b7280",
    flex: 1,
  },
  changeButton: {
    marginTop: 24,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#6366f1",
  },
  changeButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#6366f1",
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 80,
    paddingHorizontal: 24,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#ef4444",
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 15,
    color: "#6b7280",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 22,
  },
  errorActions: {
    flexDirection: "row",
    gap: 12,
  },
  retryButton: {
    backgroundColor: "#6366f1",
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 10,
    minWidth: 100,
    alignItems: "center",
  },
  retryButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  discardButton: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    alignItems: "center",
  },
  discardButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#6b7280",
  },
  submitButton: {
    backgroundColor: "#6366f1",
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: "center",
  },
  submitButtonDestructive: {
    backgroundColor: "#ef4444",
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
  },
});
