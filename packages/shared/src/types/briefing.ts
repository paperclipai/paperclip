export interface BriefingOverview {
  flightDate: string;
  departure: string;
  arrival: string;
  aircraftType: string;
  flightNumber: string;
  crewPosition: string;
  scheduledDeparture: string;
  scheduledArrival: string;
}

export interface WeatherSection {
  departure: WeatherStation;
  arrival: WeatherStation;
  alternate: WeatherStation | null;
  enroute: RouteWeather[];
}

export interface WeatherStation {
  station: string;
  metar: string;
  taf: string;
}

export interface NotamSection {
  departure: Notam[];
  arrival: Notam[];
  enroute: Notam[];
}

export interface Notam {
  id: string;
  location: string;
  type: string;
  description: string;
  startTime: string;
  endTime: string | null;
  severity: "low" | "medium" | "high";
}

export interface RouteWeather {
  segment: string;
  conditions: string;
  severity: "low" | "medium" | "high";
  details: string;
}

export interface RouteSection {
  departure: string;
  arrival: string;
  alternate: string | null;
  filedAltitude: string;
  estimatedTimeEnroute: string;
  fuelOnBoard: string;
  distance: string;
}

export interface AlertSection {
  items: CrewAlert[];
}

export interface BriefingDocument {
  documentId: string;
  documentType: string;
  originalFilename: string;
  parserStatus: string;
  uploadedAt: string;
  byteSize: number;
  sha256: string;
}

export interface FlightCrewBriefing {
  tripId: string;
  dutyDayId: string;
  overview: BriefingOverview;
  weather: WeatherSection;
  notams: NotamSection;
  route: RouteSection;
  alerts: AlertSection;
  documents?: BriefingDocument[];
}

export interface CrewAlert {
  id: string;
  type: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
}
