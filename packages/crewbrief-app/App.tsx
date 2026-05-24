import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { HomeScreen } from "./src/screens/HomeScreen";
import { BriefingScreen } from "./src/screens/BriefingScreen";
import { DashboardScreen } from "./src/screens/DashboardScreen";

export type RootStackParamList = {
  Home: undefined;
  Briefing: { tripId: string; dutyDayId: string; apiUrl: string };
  Dashboard: { apiUrl: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: { backgroundColor: "#6366f1" },
          headerTintColor: "#fff",
          headerTitleStyle: { fontWeight: "700" },
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ title: "CrewBrief" }}
        />
        <Stack.Screen
          name="Briefing"
          component={BriefingScreen}
          options={{ title: "Briefing Detail" }}
        />
        <Stack.Screen
          name="Dashboard"
          component={DashboardScreen}
          options={{ headerShown: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
