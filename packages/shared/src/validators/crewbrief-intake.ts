import { z } from "zod";

export const airportSchema = z.object({
  icao: z.string().length(4),
  iata: z.string().length(3).optional(),
  name: z.string().min(1),
  city: z.string().optional(),
  country: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  timezone: z.string().optional(),
});

export const aircraftSchema = z.object({
  type: z.string().min(1),
  registration: z.string().min(1),
  configuration: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
});

export const crewMemberSchema = z.object({
  employeeId: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  baseAirport: z.string().optional(),
});

export const legSchema = z.object({
  legNumber: z.number().int().min(1),
  flightNumber: z.string().min(1),
  origin: z.string().min(1),
  destination: z.string().min(1),
  alternate: z.string().optional(),
  scheduledDeparture: z.string().optional(),
  scheduledArrival: z.string().optional(),
  aircraftRegistration: z.string().optional(),
  filedAltitude: z.string().optional(),
  estimatedTimeEnroute: z.string().optional(),
  distance: z.string().optional(),
  fuelPlan: z.string().optional(),
  fuelUnit: z.string().default("lbs"),
});

export const tripCreateSchema = z.object({
  tripId: z.string().min(1),
  airline: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  legs: z.array(legSchema).min(1),
  crewAssignments: z.array(z.object({
    dutyDayId: z.string().min(1),
    employeeId: z.string().min(1),
    dutyDate: z.string().min(1),
    position: z.string().optional(),
    reportTime: z.string().optional(),
    releaseTime: z.string().optional(),
  })).optional(),
});

export type TripCreateInput = z.infer<typeof tripCreateSchema>;
export type AirportInput = z.infer<typeof airportSchema>;
export type AircraftInput = z.infer<typeof aircraftSchema>;
export type CrewMemberInput = z.infer<typeof crewMemberSchema>;
