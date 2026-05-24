import React from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { useFeedbackTrends } from "../useFeedbackTrends.js";

interface FeedbackDashboardScreenProps {
  apiUrl: string;
  onBack: () => void;
}

export function FeedbackDashboardScreen({
  apiUrl,
  onBack,
}: FeedbackDashboardScreenProps) {
  const { trends, loading, error, refetch } = useFeedbackTrends({ apiUrl });
  const [refreshing, setRefreshing] = React.useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  if (loading && !trends) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={styles.loadingText}>Loading feedback trends...</Text>
      </View>
    );
  }

  if (error && !trends) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Failed to Load Trends</Text>
        <Text style={styles.errorMessage}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={refetch}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const total = trends?.totalCount ?? 0;

  const ratingColors: Record<string, string> = {
    yes: "#059669",
    somewhat: "#b45309",
    no: "#dc2626",
  };

  const ratingLabels: Record<string, string> = {
    yes: "Helpful",
    somewhat: "Somewhat",
    no: "Not Helpful",
  };

  const categoryLabels: Record<string, string> = {
    inaccurate_info: "Inaccurate Info",
    missing_section: "Missing Section",
    hard_to_read: "Hard to Read",
    late_delivery: "Late Delivery",
    other: "Other",
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Feedback Dashboard</Text>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#6366f1"
          />
        }
      >
        <View style={styles.summaryCard}>
          <Text style={styles.summaryNumber}>{total}</Text>
          <Text style={styles.summaryLabel}>Total Responses</Text>
        </View>

        {trends && trends.ratingBreakdown.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Ratings</Text>
            {trends.ratingBreakdown.map((rb) => (
              <View key={rb.rating} style={styles.statRow}>
                <View style={styles.statLabelRow}>
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: ratingColors[rb.rating] ?? "#6b7280" },
                    ]}
                  />
                  <Text style={styles.statLabel}>
                    {ratingLabels[rb.rating] ?? rb.rating}
                  </Text>
                </View>
                <Text style={styles.statCount}>{rb.count}</Text>
              </View>
            ))}
          </View>
        )}

        {trends && trends.categoryBreakdown.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Categories</Text>
            {trends.categoryBreakdown.map((cb) => (
              <View key={cb.category ?? "none"} style={styles.statRow}>
                <Text style={styles.statLabel}>
                  {cb.category ? (categoryLabels[cb.category] ?? cb.category) : "No Category"}
                </Text>
                <Text style={styles.statCount}>{cb.count}</Text>
              </View>
            ))}
          </View>
        )}

        {trends && trends.recentFeedback.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Recent Feedback</Text>
            {trends.recentFeedback.map((fb) => (
              <View key={fb.id} style={styles.feedbackItem}>
                <View style={styles.feedbackHeader}>
                  <Text
                    style={[
                      styles.feedbackRating,
                      { color: ratingColors[fb.rating] ?? "#6b7280" },
                    ]}
                  >
                    {ratingLabels[fb.rating] ?? fb.rating}
                  </Text>
                  {fb.category && (
                    <Text style={styles.feedbackCategory}>
                      {categoryLabels[fb.category] ?? fb.category}
                    </Text>
                  )}
                </View>
                {fb.freeText && (
                  <Text style={styles.feedbackText} numberOfLines={3}>
                    {fb.freeText}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}

        {total === 0 && (
          <View style={styles.card}>
            <Text style={styles.emptyText}>No feedback yet.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f3f4f6",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#6366f1",
  },
  backButton: {
    paddingRight: 12,
  },
  backButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f3f4f6",
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: "#6b7280",
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 15,
    color: "#6b7280",
    textAlign: "center",
    marginBottom: 24,
  },
  retryButton: {
    backgroundColor: "#6366f1",
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 10,
  },
  retryButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  summaryCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 24,
    marginBottom: 16,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  summaryNumber: {
    fontSize: 48,
    fontWeight: "800",
    color: "#6366f1",
  },
  summaryLabel: {
    fontSize: 16,
    color: "#6b7280",
    marginTop: 4,
    fontWeight: "500",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 16,
  },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
  },
  statLabelRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  statLabel: {
    fontSize: 15,
    color: "#374151",
    fontWeight: "500",
  },
  statCount: {
    fontSize: 16,
    color: "#111827",
    fontWeight: "700",
  },
  feedbackItem: {
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  feedbackHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  feedbackRating: {
    fontSize: 14,
    fontWeight: "700",
  },
  feedbackCategory: {
    fontSize: 12,
    color: "#6b7280",
    backgroundColor: "#e5e7eb",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
  },
  feedbackText: {
    fontSize: 14,
    color: "#6b7280",
    lineHeight: 20,
    marginTop: 4,
  },
  emptyText: {
    fontSize: 15,
    color: "#9ca3af",
    textAlign: "center",
    paddingVertical: 24,
  },
});
