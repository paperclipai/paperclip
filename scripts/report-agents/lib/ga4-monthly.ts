import { google } from "googleapis";

export interface GA4MonthlyMetrics {
  activeUsers: number;
  activeUsersPctChange: number;
  newUsers: number;
  newUsersPctChange: number;
  sessions: number;
  sessionsPctChange: number;
  avgSessionDuration: number;
  bounceRate: number;
  topCountries: Array<{ country: string; activeUsers: number }>;
  trafficSources: Array<{ source: string; sessions: number }>;
  topLandingPages: Array<{ page: string; sessions: number }>;
}

export async function fetchGA4MonthlyMetrics(): Promise<GA4MonthlyMetrics> {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) throw new Error("Missing GA4_PROPERTY_ID");

  const credentialsJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  const auth = credentialsJson
    ? new google.auth.GoogleAuth({
        credentials: JSON.parse(credentialsJson),
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
      })
    : new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
      });

  const analyticsData = google.analyticsdata({ version: "v1beta", auth });
  const prop = `properties/${propertyId}`;

  // Calculate last month range
  const now = new Date();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const thisMonth = { startDate: fmt(lastMonthStart), endDate: fmt(lastMonthEnd) };
  const prevMonth = { startDate: fmt(prevMonthStart), endDate: fmt(prevMonthEnd) };

  const [curTotals, prevTotals, countryData, trafficData, landingData] = await Promise.all([
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [thisMonth],
        metrics: [
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "sessions" },
          { name: "averageSessionDuration" },
          { name: "bounceRate" },
        ],
      },
    }),
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [prevMonth],
        metrics: [
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "sessions" },
          { name: "averageSessionDuration" },
          { name: "bounceRate" },
        ],
      },
    }),
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [thisMonth],
        metrics: [{ name: "activeUsers" }],
        dimensions: [{ name: "country" }],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit: "10",
      },
    }),
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [thisMonth],
        metrics: [{ name: "sessions" }],
        dimensions: [{ name: "sessionDefaultChannelGroup" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "5",
      },
    }),
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [thisMonth],
        metrics: [{ name: "sessions" }],
        dimensions: [{ name: "landingPage" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "20",
      },
    }),
  ]);

  const cur = curTotals.data.rows?.[0]?.metricValues ?? [];
  const prev = prevTotals.data.rows?.[0]?.metricValues ?? [];
  const pctChange = (a: number, b: number) => b > 0 ? ((a - b) / b) * 100 : 0;

  const c = {
    activeUsers: Number(cur[0]?.value ?? 0),
    newUsers: Number(cur[1]?.value ?? 0),
    sessions: Number(cur[2]?.value ?? 0),
    avgSessionDuration: Number(cur[3]?.value ?? 0),
    bounceRate: Number(cur[4]?.value ?? 0) * 100,
  };
  const p = {
    activeUsers: Number(prev[0]?.value ?? 0),
    newUsers: Number(prev[1]?.value ?? 0),
    sessions: Number(prev[2]?.value ?? 0),
  };

  const parseRows = (data: any, dimKey: string, metKey: string) =>
    (data.data.rows ?? []).map((row: any) => ({
      [dimKey]: row.dimensionValues?.[0]?.value ?? "Unknown",
      [metKey]: Number(row.metricValues?.[0]?.value ?? 0),
    }));

  return {
    activeUsers: c.activeUsers,
    activeUsersPctChange: pctChange(c.activeUsers, p.activeUsers),
    newUsers: c.newUsers,
    newUsersPctChange: pctChange(c.newUsers, p.newUsers),
    sessions: c.sessions,
    sessionsPctChange: pctChange(c.sessions, p.sessions),
    avgSessionDuration: c.avgSessionDuration,
    bounceRate: c.bounceRate,
    topCountries: parseRows(countryData, "country", "activeUsers"),
    trafficSources: parseRows(trafficData, "source", "sessions"),
    topLandingPages: parseRows(landingData, "page", "sessions")
      .filter((p: any) => /^\/en\/premarket\//.test(p.page)),
  };
}
