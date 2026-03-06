import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  extractIssueIdFromDeepLink,
  parseIssueWakePayload,
  type IssueWakeKind,
  type IssueWakePayload,
} from "./notification-contract";

const NOTIFICATION_PREF_KEY_PREFIX = "paperclip-mobile:notification-pref";

export type NotificationPreference = "enabled" | "disabled";

function notificationPrefKey(companyId: string, agentId: string): string {
  return `${NOTIFICATION_PREF_KEY_PREFIX}:${companyId}:${agentId}`;
}

export async function loadNotificationPreference(
  companyId: string,
  agentId: string,
): Promise<NotificationPreference> {
  const raw = await AsyncStorage.getItem(notificationPrefKey(companyId, agentId));
  return raw === "enabled" ? "enabled" : "disabled";
}

export async function saveNotificationPreference(
  companyId: string,
  agentId: string,
  preference: NotificationPreference,
): Promise<void> {
  await AsyncStorage.setItem(notificationPrefKey(companyId, agentId), preference);
}

export {
  extractIssueIdFromDeepLink,
  parseIssueWakePayload,
  type IssueWakeKind,
  type IssueWakePayload,
};

export interface PushRegistrationResult {
  permission: Notifications.PermissionStatus;
  expoPushToken: string | null;
  detail: string;
}

export async function registerForPushNotifications(): Promise<PushRegistrationResult> {
  if (!Device.isDevice) {
    return {
      permission: Notifications.PermissionStatus.DENIED,
      expoPushToken: null,
      detail: "Push registration needs a physical Android/iOS device (simulator unsupported).",
    };
  }

  const current = await Notifications.getPermissionsAsync();
  let finalStatus = current.status;
  if (finalStatus !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    finalStatus = requested.status;
  }

  if (finalStatus !== "granted") {
    return {
      permission: finalStatus,
      expoPushToken: null,
      detail: "OS notification permission not granted.",
    };
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return {
      permission: finalStatus,
      expoPushToken: token.data ?? null,
      detail: token.data
        ? "Push permission granted and Expo token provisioned."
        : "Push permission granted; token unavailable.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      permission: finalStatus,
      expoPushToken: null,
      detail: `Push permission granted; token provisioning failed: ${message}`,
    };
  }
}
