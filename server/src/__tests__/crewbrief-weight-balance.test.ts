import { describe, expect, it } from "vitest";
import { deterministicParseWeightBalance } from "../services/crewbrief-weight-balance.js";

describe("deterministicParseWeightBalance", () => {
  it("rejects text with fewer than 5 lines", () => {
    const result = deterministicParseWeightBalance("too\nshort");
    expect(result).toBeNull();
  });

  it("rejects text with no W&B indicators", () => {
    const text = [
      "Line one",
      "Line two",
      "Line three",
      "Line four",
      "Line five",
      "This is just regular text without any weight and balance terms",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).toBeNull();
  });

  it("extracts basic empty weight (BEW)", () => {
    const text = [
      "Weight and Balance Report",
      "Aircraft: N12345",
      "Date: 2025-03-15",
      "Basic Empty Weight: 21500 lbs",
      "Max Takeoff Weight: 48000 lbs",
      "Max Landing Weight: 44000 lbs",
      "Zero Fuel Weight: 35000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.basicEmptyWeight).toMatch(/21500/);
    expect(result!.maxTakeoffWeight).toMatch(/48000/);
    expect(result!.maxLandingWeight).toMatch(/44000/);
    expect(result!.zeroFuelWeight).toMatch(/35000/);
  });

  it("extracts operating empty weight (OEW)", () => {
    const text = [
      "Weight and Balance Sheet",
      "Aircraft: N67890",
      "Operating Empty Weight: 27800 lbs",
      "Max Ramp Weight: 67500 lbs",
      "Max Takeoff Weight: 67000 lbs",
      "Max Landing Weight: 57000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.operatingEmptyWeight).toMatch(/27800/);
    expect(result!.maxRampWeight).toMatch(/67500/);
  });

  it("extracts takeoff, landing, ramp weights and CG", () => {
    const text = [
      "AIRCRAFT WEIGHT AND BALANCE",
      "Registration: N98765",
      "Takeoff Weight: 52000 lbs",
      "Landing Weight: 48000 lbs",
      "Ramp Weight: 52150 lbs",
      "Payload: 8500 lbs",
      "Zero Fuel Weight: 38000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.takeoffWeight).toMatch(/52000/);
    expect(result!.landingWeight).toMatch(/48000/);
    expect(result!.rampWeight).toMatch(/52150/);
    expect(result!.payload).toMatch(/8500/);
    expect(result!.zeroFuelWeight).toMatch(/38000/);
  });

  it("extracts fuel values", () => {
    const text = [
      "FUEL AND LOADING DATA",
      "Aircraft: N12345",
      "Total Fuel: 12000 lbs",
      "Trip Fuel: 8500 lbs",
      "Fuel Unit: lbs",
      "Basic Empty Weight: 25000 lbs",
      "Max Takeoff Weight: 60000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.fuelRamp).toMatch(/12000/);
    expect(result!.fuelTrip).toMatch(/8500/);
    expect(result!.fuelUnit).toBe("lbs");
  });

  it("extracts aircraft registration and type", () => {
    const text = [
      "WEIGHT AND BALANCE MANIFEST",
      "Aircraft Type: Gulfstream G650",
      "Registration: N456GH",
      "Basic Empty Weight: 45000 lbs",
      "Max Takeoff Weight: 99500 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.aircraftRegistration).toBe("N456GH");
    expect(result!.aircraftType).toContain("Gulfstream");
  });

  it("extracts document date", () => {
    const text = [
      "WEIGHT AND BALANCE",
      "Date: 2025-06-15",
      "Aircraft: N12345",
      "Basic Empty Weight: 22000 lbs",
      "Max Takeoff Weight: 48000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.documentDate).toBeTruthy();
    expect(result!.documentDate).toContain("2025");
  });

  it("extracts fuel unit as kg when present", () => {
    const text = [
      "CENTRE DE GRAVITÉ",
      "Aircraft: F-GYRE",
      "Basic Empty Weight: 12500 kg",
      "Max Takeoff Weight: 28000 kg",
      "Fuel: 4000 kg",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.fuelUnit).toBe("kg");
    expect(result!.basicEmptyWeight).toContain("kg");
  });

  it("extracts passenger count", () => {
    const text = [
      "WEIGHT AND BALANCE",
      "Aircraft: N12345",
      "Basic Empty Weight: 22000 lbs",
      "Passengers: 8",
      "Max Takeoff Weight: 48000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.passengerCount).toBe("8");
  });

  it("extracts MZFW", () => {
    const text = [
      "WEIGHT AND BALANCE",
      "Aircraft: N12345",
      "Basic Empty Weight: 22000 lbs",
      "Max Zero Fuel Weight: 36000 lbs",
      "MZFW: 36000 lbs",
      "Max Takeoff Weight: 48000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.maxZeroFuelWeight).toMatch(/36000/);
  });

  it("extracts stations/load distribution from table format", () => {
    const text = [
      "WEIGHT AND BALANCE LOAD DISTRIBUTION",
      "Station              Weight    Arm     Moment",
      "Cockpit               340     120.5    40970",
      "Forward Cabin        1200     200.0   240000",
      "Aft Cabin             800     350.0   280000",
      "Forward Baggage       150     180.0    27000",
      "Aft Baggage           200     400.0    80000",
      "Total                2690",
      "Basic Empty Weight: 22000 lbs",
      "Max Takeoff Weight: 48000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.stations).toBeDefined();
    expect(result!.stations!.length).toBeGreaterThanOrEqual(4);
    expect(result!.stations!.some(s => s.station.includes("Cockpit"))).toBe(true);
    expect(result!.stations!.some(s => s.weight === "340")).toBe(true);
  });

  it("returns null when essential fields are missing", () => {
    const text = [
      "Some random text",
      "with weight mentioned",
      "but no actual data",
      "just talking about",
      "how heavy things are",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).toBeNull();
  });

  it("handles BEW/OEW abbreviations", () => {
    const text = [
      "WEIGHT AND BALANCE DATA",
      "Aircraft: N12345",
      "BEW: 18500 lbs",
      "MTOW: 35000 lbs",
      "MLW: 32000 lbs",
      "ZFW: 25000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.basicEmptyWeight).toMatch(/18500/);
    expect(result!.maxTakeoffWeight).toMatch(/35000/);
    expect(result!.maxLandingWeight).toMatch(/32000/);
    expect(result!.zeroFuelWeight).toMatch(/25000/);
  });

  it("handles OEW abbreviation", () => {
    const text = [
      "WEIGHT SUMMARY",
      "Aircraft: N12345",
      "OEW: 27500 lbs",
      "MTOW: 55000 lbs",
      "Payload: 12000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.operatingEmptyWeight).toMatch(/27500/);
    expect(result!.payload).toMatch(/12000/);
  });

  it("generates tripId from tail number and date", () => {
    const text = [
      "WEIGHT AND BALANCE REPORT",
      "Aircraft: N12345",
      "Date: 2025-06-15",
      "Basic Empty Weight: 22000 lbs",
      "Max Takeoff Weight: 48000 lbs",
    ].join("\n");
    const result = deterministicParseWeightBalance(text);
    expect(result).not.toBeNull();
    expect(result!.tripId).toContain("WB-");
    expect(result!.tripId).toContain("N12345");
  });
});
