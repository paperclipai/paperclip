import React from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import { FeedbackDashboardScreen } from "@paperclipai/react-native-hooks";

type Props = NativeStackScreenProps<RootStackParamList, "Dashboard">;

export function DashboardScreen({ navigation, route }: Props) {
  return (
    <FeedbackDashboardScreen
      apiUrl={route.params.apiUrl}
      onBack={() => navigation.goBack()}
    />
  );
}
