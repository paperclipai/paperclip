import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { useBriefingDetail } from "../useBriefingDetail.js";
import { FeedbackSheet } from "./FeedbackSheet.js";
import type { FlightCrewBriefing } from "@paperclipai/shared";

interface BriefingDetailScreenProps {
  apiUrl: string;
  tripId: string;
  dutyDayId: string;
}

export function BriefingDetailScreen({
  apiUrl,
  tripId,
  dutyDayId,
}: BriefingDetailScreenProps) {
  const { briefing, loading, error, refetch } = useBriefingDetail({
    apiUrl,
    tripId,
    dutyDayId,
  });
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  if (loading && !briefing) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={styles.loadingText}>Loading briefing...</Text>
      </View>
    );
  }

  if (error && !briefing) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorIcon}>!</Text>
        <Text style={styles.errorTitle}>Failed to Load Briefing</Text>
        <Text style={styles.errorMessage}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={refetch}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!briefing) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Briefing Not Found</Text>
        <Text style={styles.errorMessage}>
          No briefing found for this trip and duty day.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
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
        <OverviewSection overview={briefing.overview} />
        <WeatherSection weather={briefing.weather} />
        <NotamSection notams={briefing.notams} />
        <RouteSection route={briefing.route} />
        <AlertSection alerts={briefing.alerts} />
      </ScrollView>

      <TouchableOpacity
        style={styles.feedbackFAB}
        onPress={() => setFeedbackVisible(true)}
      >
        <Text style={styles.feedbackFABText}>Feedback</Text>
      </TouchableOpacity>

      <FeedbackSheet
        visible={feedbackVisible}
        briefingId={briefing.tripId}
        apiUrl={apiUrl}
        onClose={() => setFeedbackVisible(false)}
      />
    </View>
  );
}

function OverviewSection({
  overview,
}: {
  overview: FlightCrewBriefing["overview"];
}) {
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.heading}>Overview</Text>
      <View style={sectionStyles.grid}>
        <DetailRow label="Flight" value={overview.flightNumber} />
        <DetailRow label="Date" value={overview.flightDate} />
        <DetailRow label="Aircraft" value={overview.aircraftType} />
        <DetailRow label="Route" value={`${overview.departure} → ${overview.arrival}`} />
        <DetailRow label="Position" value={overview.crewPosition} />
        <DetailRow label="STD" value={overview.scheduledDeparture} />
        <DetailRow label="STA" value={overview.scheduledArrival} />
      </View>
    </View>
  );
}

function WeatherSection({
  weather,
}: {
  weather: FlightCrewBriefing["weather"];
}) {
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.heading}>Weather</Text>

      <StationCard
        title="Departure"
        station={weather.departure.station}
        metar={weather.departure.metar}
        taf={weather.departure.taf}
      />

      <StationCard
        title="Arrival"
        station={weather.arrival.station}
        metar={weather.arrival.metar}
        taf={weather.arrival.taf}
      />

      {weather.alternate && (
        <StationCard
          title="Alternate"
          station={weather.alternate.station}
          metar={weather.alternate.metar}
          taf={weather.alternate.taf}
        />
      )}

      {weather.enroute.length > 0 && (
        <View style={sectionStyles.subSection}>
          <Text style={sectionStyles.subHeading}>Enroute Weather</Text>
          {weather.enroute.map((rw, idx) => (
            <View key={idx} style={sectionStyles.weatherItem}>
              <View style={sectionStyles.weatherHeader}>
                <Text style={sectionStyles.weatherSegment}>{rw.segment}</Text>
                <SeverityBadge severity={rw.severity} />
              </View>
              <Text style={sectionStyles.weatherDetails}>{rw.conditions}</Text>
              {rw.details && (
                <Text style={sectionStyles.weatherDetails}>{rw.details}</Text>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function StationCard({
  title,
  station,
  metar,
  taf,
}: {
  title: string;
  station: string;
  metar: string;
  taf: string;
}) {
  return (
    <View style={sectionStyles.stationCard}>
      <Text style={sectionStyles.stationTitle}>
        {title} — {station}
      </Text>
      <Text style={sectionStyles.dataLabel}>METAR</Text>
      <Text style={sectionStyles.dataValue}>{metar}</Text>
      <Text style={sectionStyles.dataLabel}>TAF</Text>
      <Text style={sectionStyles.dataValue}>{taf}</Text>
    </View>
  );
}

function NotamSection({
  notams,
}: {
  notams: FlightCrewBriefing["notams"];
}) {
  const categories = [
    { key: "departure" as const, label: "Departure" },
    { key: "arrival" as const, label: "Arrival" },
    { key: "enroute" as const, label: "Enroute" },
  ];

  const hasNotams = categories.some((c) => notams[c.key].length > 0);
  if (!hasNotams) {
    return (
      <View style={sectionStyles.container}>
        <Text style={sectionStyles.heading}>NOTAMs</Text>
        <Text style={sectionStyles.emptyText}>No NOTAMs reported.</Text>
      </View>
    );
  }

  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.heading}>NOTAMs</Text>
      {categories.map(({ key, label }) =>
        notams[key].length > 0 ? (
          <View key={key} style={sectionStyles.subSection}>
            <Text style={sectionStyles.subHeading}>{label}</Text>
            {notams[key].map((notam) => (
              <View key={notam.id} style={sectionStyles.notamCard}>
                <View style={sectionStyles.notamHeader}>
                  <Text style={sectionStyles.notamLocation}>
                    {notam.location} — {notam.type}
                  </Text>
                  <SeverityBadge severity={notam.severity} />
                </View>
                <Text style={sectionStyles.notamDescription}>
                  {notam.description}
                </Text>
                {notam.endTime && (
                  <Text style={sectionStyles.notamValidity}>
                    Valid until: {notam.endTime}
                  </Text>
                )}
              </View>
            ))}
          </View>
        ) : null,
      )}
    </View>
  );
}

function RouteSection({ route }: { route: FlightCrewBriefing["route"] }) {
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.heading}>Route</Text>
      <View style={sectionStyles.grid}>
        <DetailRow label="From" value={route.departure} />
        <DetailRow label="To" value={route.arrival} />
        {route.alternate && <DetailRow label="Alternate" value={route.alternate} />}
        <DetailRow label="Altitude" value={route.filedAltitude} />
        <DetailRow label="ETE" value={route.estimatedTimeEnroute} />
        <DetailRow label="Fuel" value={route.fuelOnBoard} />
        <DetailRow label="Distance" value={route.distance} />
      </View>
    </View>
  );
}

function AlertSection({
  alerts,
}: {
  alerts: FlightCrewBriefing["alerts"];
}) {
  if (alerts.items.length === 0) {
    return (
      <View style={sectionStyles.container}>
        <Text style={sectionStyles.heading}>Alerts</Text>
        <Text style={sectionStyles.emptyText}>No alerts.</Text>
      </View>
    );
  }

  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.heading}>Alerts</Text>
      {alerts.items.map((alert) => (
        <View
          key={alert.id}
          style={[
            sectionStyles.alertCard,
            alert.severity === "critical" && sectionStyles.alertCritical,
            alert.severity === "warning" && sectionStyles.alertWarning,
            alert.severity === "info" && sectionStyles.alertInfo,
          ]}
        >
          <Text style={sectionStyles.alertType}>{alert.type}</Text>
          <Text style={sectionStyles.alertTitle}>{alert.title}</Text>
          <Text style={sectionStyles.alertDescription}>{alert.description}</Text>
        </View>
      ))}
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={sectionStyles.detailRow}>
      <Text style={sectionStyles.detailLabel}>{label}</Text>
      <Text style={sectionStyles.detailValue}>{value}</Text>
    </View>
  );
}

function SeverityBadge({
  severity,
}: {
  severity: "low" | "medium" | "high" | "info" | "warning" | "critical";
}) {
  const colorMap: Record<string, { bg: string; text: string }> = {
    low: { bg: "#dbeafe", text: "#1d4ed8" },
    medium: { bg: "#fef3c7", text: "#b45309" },
    high: { bg: "#fce7f3", text: "#be123c" },
    info: { bg: "#dbeafe", text: "#1d4ed8" },
    warning: { bg: "#fef3c7", text: "#b45309" },
    critical: { bg: "#fce7f3", text: "#be123c" },
  };

  const colors = colorMap[severity] ?? colorMap.info;

  return (
    <View style={[sectionStyles.badge, { backgroundColor: colors.bg }]}>
      <Text style={[sectionStyles.badgeText, { color: colors.text }]}>
        {severity.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f3f4f6",
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 80,
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
  errorIcon: {
    fontSize: 48,
    fontWeight: "700",
    color: "#ef4444",
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
    borderColor: "#ef4444",
    textAlign: "center",
    lineHeight: 58,
    marginBottom: 16,
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
  feedbackFAB: {
    position: "absolute",
    bottom: 24,
    right: 24,
    backgroundColor: "#6366f1",
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 28,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  feedbackFABText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});

const sectionStyles = StyleSheet.create({
  container: {
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
  heading: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 16,
  },
  subSection: {
    marginTop: 16,
  },
  subHeading: {
    fontSize: 16,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 10,
  },
  grid: {
    gap: 12,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  detailLabel: {
    fontSize: 15,
    color: "#6b7280",
    fontWeight: "500",
  },
  detailValue: {
    fontSize: 15,
    color: "#111827",
    fontWeight: "600",
    textAlign: "right",
    flexShrink: 1,
    marginLeft: 12,
  },
  stationCard: {
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  stationTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 10,
  },
  dataLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#6b7280",
    marginTop: 6,
    marginBottom: 2,
    letterSpacing: 0.5,
  },
  dataValue: {
    fontSize: 14,
    color: "#374151",
    fontFamily: "monospace",
    lineHeight: 20,
  },
  weatherItem: {
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  weatherHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  weatherSegment: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111827",
  },
  weatherDetails: {
    fontSize: 14,
    color: "#374151",
    lineHeight: 20,
    marginTop: 2,
  },
  badge: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  notamCard: {
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: "#6366f1",
  },
  notamHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  notamLocation: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111827",
    flexShrink: 1,
  },
  notamDescription: {
    fontSize: 14,
    color: "#374151",
    lineHeight: 20,
  },
  notamValidity: {
    fontSize: 12,
    color: "#9ca3af",
    marginTop: 6,
  },
  alertCard: {
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  alertCritical: {
    backgroundColor: "#fef2f2",
    borderLeftWidth: 3,
    borderLeftColor: "#ef4444",
  },
  alertWarning: {
    backgroundColor: "#fffbeb",
    borderLeftWidth: 3,
    borderLeftColor: "#f59e0b",
  },
  alertInfo: {
    backgroundColor: "#eff6ff",
    borderLeftWidth: 3,
    borderLeftColor: "#3b82f6",
  },
  alertType: {
    fontSize: 12,
    fontWeight: "700",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  alertTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111827",
    marginBottom: 4,
  },
  alertDescription: {
    fontSize: 14,
    color: "#374151",
    lineHeight: 20,
  },
  emptyText: {
    fontSize: 15,
    color: "#9ca3af",
    textAlign: "center",
    paddingVertical: 16,
  },
});
