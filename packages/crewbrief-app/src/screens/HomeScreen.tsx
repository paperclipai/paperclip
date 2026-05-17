import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

const DEFAULT_API_URL = __DEV__
  ? Platform.OS === "android"
    ? "http://10.0.2.2:3100"
    : "http://localhost:3100"
  : "https://api.crewbrief.app";

export function HomeScreen({ navigation }: Props) {
  const [tripId, setTripId] = useState("demo-trip-001");
  const [dutyDayId, setDutyDayId] = useState("demo-duty-001");
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);

  const handleViewBriefing = () => {
    navigation.navigate("Briefing", { tripId, dutyDayId, apiUrl });
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>CrewBrief</Text>
        <Text style={styles.subtitle}>Flight Briefing Viewer</Text>

        <View style={styles.card}>
          <Text style={styles.label}>API URL</Text>
          <TextInput
            style={styles.input}
            value={apiUrl}
            onChangeText={setApiUrl}
            placeholder="http://localhost:3100"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={styles.label}>Trip ID</Text>
          <TextInput
            style={styles.input}
            value={tripId}
            onChangeText={setTripId}
            placeholder="trip-001"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
          />

          <Text style={styles.label}>Duty Day ID</Text>
          <TextInput
            style={styles.input}
            value={dutyDayId}
            onChangeText={setDutyDayId}
            placeholder="duty-001"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
          />

          <TouchableOpacity
            style={styles.button}
            onPress={handleViewBriefing}
          >
            <Text style={styles.buttonText}>View Briefing</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => navigation.navigate("Dashboard", { apiUrl })}
          >
            <Text style={styles.secondaryButtonText}>Feedback Dashboard</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f3f4f6",
  },
  scrollContent: {
    padding: 24,
    paddingTop: 48,
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    color: "#111827",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: "#6b7280",
    textAlign: "center",
    marginBottom: 32,
    marginTop: 4,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    color: "#111827",
    backgroundColor: "#f9fafb",
  },
  button: {
    backgroundColor: "#6366f1",
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 24,
  },
  buttonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  secondaryButton: {
    borderWidth: 1.5,
    borderColor: "#6366f1",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 12,
  },
  secondaryButtonText: {
    color: "#6366f1",
    fontSize: 16,
    fontWeight: "600",
  },
});
