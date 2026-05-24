import React from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import { BriefingDetailScreen } from "@paperclipai/react-native-hooks";

type Props = NativeStackScreenProps<RootStackParamList, "Briefing">;

export function BriefingScreen({ route }: Props) {
  const { tripId, dutyDayId, apiUrl } = route.params;

  return (
    <BriefingDetailScreen
      apiUrl={apiUrl}
      tripId={tripId}
      dutyDayId={dutyDayId}
    />
  );
}
