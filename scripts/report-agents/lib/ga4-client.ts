import { google } from "googleapis";

export interface GA4Metrics {
  activeUsers: number;
  activeUsersPctChange: number;
  newUsers: number;
  newUsersPctChange: number;
  eventCount: number;
  eventCountPctChange: number;
  topCountries: Array<{ country: string; activeUsers: number }>;
  trafficSources: Array<{ source: string; sessions: number }>;
}

export async function fetchGA4Metrics(): Promise<GA4Metrics> {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) throw new Error("Missing GA4_PROPERTY_ID");

  // Support both: Service Account JSON (env) or Application Default Credentials (gcloud auth)
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

  const [current, previous, trafficData] = await Promise.all([
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        metrics: [
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "eventCount" },
        ],
        dimensions: [{ name: "country" }],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit: "10",
      },
    }),
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: "14daysAgo", endDate: "8daysAgo" }],
        metrics: [
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "eventCount" },
        ],
      },
    }),
    analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        metrics: [{ name: "sessions" }],
        dimensions: [{ name: "sessionDefaultChannelGroup" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "5",
      },
    }),
  ]);

  const trafficSources = (trafficData.data.rows ?? []).map((row) => ({
    source: row.dimensionValues?.[0]?.value ?? "Unknown",
    sessions: Number(row.metricValues?.[0]?.value ?? 0),
  }));

  const curTotals = current.data.totals?.[0]?.metricValues ?? [];
  const prevTotals = previous.data.totals?.[0]?.metricValues ?? [];

  const cur = {
    activeUsers: Number(curTotals[0]?.value ?? 0),
    newUsers: Number(curTotals[1]?.value ?? 0),
    eventCount: Number(curTotals[2]?.value ?? 0),
  };
  const prev = {
    activeUsers: Number(prevTotals[0]?.value ?? 0),
    newUsers: Number(prevTotals[1]?.value ?? 0),
    eventCount: Number(prevTotals[2]?.value ?? 0),
  };

  const pctChange = (c: number, p: number) => p > 0 ? ((c - p) / p) * 100 : 0;

  const topCountries = (current.data.rows ?? []).slice(0, 5).map((row) => ({
    country: row.dimensionValues?.[0]?.value ?? "Unknown",
    activeUsers: Number(row.metricValues?.[0]?.value ?? 0),
  }));

  return {
    activeUsers: cur.activeUsers,
    activeUsersPctChange: pctChange(cur.activeUsers, prev.activeUsers),
    newUsers: cur.newUsers,
    newUsersPctChange: pctChange(cur.newUsers, prev.newUsers),
    eventCount: cur.eventCount,
    eventCountPctChange: pctChange(cur.eventCount, prev.eventCount),
    topCountries,
    trafficSources,
  };
}
