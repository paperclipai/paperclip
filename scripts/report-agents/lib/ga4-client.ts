import { google } from "googleapis";
import { execSync } from "child_process";

// Auto-refresh ADC if expired
export async function refreshADCIfNeeded(): Promise<void> {
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    });
    const client = await auth.getClient();
    await (client as any).getAccessToken();
  } catch (e: any) {
    if (e.message?.includes("invalid_grant") || e.message?.includes("Token has been expired") || e.message?.includes("Insufficient Permission")) {
      console.log("GA4: ADC expired, attempting refresh...");
      try {
        execSync(
          'gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics.readonly --quiet --no-launch-browser 2>/dev/null',
          { env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/share/google-cloud-sdk/bin` }, timeout: 10_000 }
        );
      } catch {
        throw new Error("GA4 credentials expired. Run: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics.readonly");
      }
    } else {
      throw e;
    }
  }
}

export interface GA4Metrics {
  activeUsers: number;
  activeUsersPctChange: number;
  newUsers: number;
  newUsersPctChange: number;
  sessions: number;
  sessionsPctChange: number;
  eventCount: number;
  eventCountPctChange: number;
  avgSessionDuration: number;
  avgSessionDurationPctChange: number;
  bounceRate: number;
  bounceRatePctChange: number;
  topCountries: Array<{ country: string; activeUsers: number }>;
  trafficSources: Array<{ source: string; sessions: number }>;
  topPages: Array<{ page: string; views: number }>;
  devices: Array<{ device: string; users: number }>;
  topReferrals: Array<{ referrer: string; sessions: number }>;
  topLandingPages: Array<{ page: string; sessions: number }>;
}

export async function fetchGA4Metrics(): Promise<GA4Metrics> {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) throw new Error("Missing GA4_PROPERTY_ID");

  // Try refresh if using ADC
  if (!process.env.GA4_SERVICE_ACCOUNT_JSON && !process.env.GA4_SERVICE_ACCOUNT_JSON_PATH) {
    await refreshADCIfNeeded();
  }

  // Support: SA JSON string, SA JSON file path, or Application Default Credentials
  const credentialsJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  const credentialsPath = process.env.GA4_SERVICE_ACCOUNT_JSON_PATH;

  let auth: any;
  if (credentialsJson) {
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(credentialsJson),
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    });
  } else if (credentialsPath) {
    auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    });
  }

  const analyticsData = google.analyticsdata({ version: "v1beta", auth });
  const prop = `properties/${propertyId}`;
  const yesterday = { startDate: "yesterday", endDate: "yesterday" };
  const dayBefore = { startDate: "2daysAgo", endDate: "2daysAgo" };

  const [currentTotals, prevTotals, countryData, trafficData, pageData, deviceData, referralData, landingData] = await Promise.all([
    // 1. Current totals
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [yesterday],
        metrics: [
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "sessions" },
          { name: "eventCount" },
          { name: "averageSessionDuration" },
          { name: "bounceRate" },
        ],
      },
    }),
    // 2. Previous totals
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [dayBefore],
        metrics: [
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "sessions" },
          { name: "eventCount" },
          { name: "averageSessionDuration" },
          { name: "bounceRate" },
        ],
      },
    }),
    // 3. Top countries
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [yesterday],
        metrics: [{ name: "activeUsers" }],
        dimensions: [{ name: "country" }],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit: "5",
      },
    }),
    // 4. Traffic sources
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [yesterday],
        metrics: [{ name: "sessions" }],
        dimensions: [{ name: "sessionDefaultChannelGroup" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "5",
      },
    }),
    // 5. Top pages
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [yesterday],
        metrics: [{ name: "screenPageViews" }],
        dimensions: [{ name: "pagePath" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: "5",
      },
    }),
    // 6. Devices
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [yesterday],
        metrics: [{ name: "activeUsers" }],
        dimensions: [{ name: "deviceCategory" }],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      },
    }),
    // 7. Top referrals
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [yesterday],
        metrics: [{ name: "sessions" }],
        dimensions: [{ name: "sessionSource" }],
        dimensionFilter: {
          filter: {
            fieldName: "sessionDefaultChannelGroup",
            stringFilter: { value: "Referral", matchType: "EXACT" },
          },
        },
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "5",
      },
    }),
    // 8. Top landing pages
    analyticsData.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [yesterday],
        metrics: [{ name: "sessions" }],
        dimensions: [{ name: "landingPage" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "20",
      },
    }),
  ]);

  const cur = currentTotals.data.rows?.[0]?.metricValues ?? [];
  const prev = prevTotals.data.rows?.[0]?.metricValues ?? [];

  const c = {
    activeUsers: Number(cur[0]?.value ?? 0),
    newUsers: Number(cur[1]?.value ?? 0),
    sessions: Number(cur[2]?.value ?? 0),
    eventCount: Number(cur[3]?.value ?? 0),
    avgSessionDuration: Number(cur[4]?.value ?? 0),
    bounceRate: Number(cur[5]?.value ?? 0),
  };
  const p = {
    activeUsers: Number(prev[0]?.value ?? 0),
    newUsers: Number(prev[1]?.value ?? 0),
    sessions: Number(prev[2]?.value ?? 0),
    eventCount: Number(prev[3]?.value ?? 0),
    avgSessionDuration: Number(prev[4]?.value ?? 0),
    bounceRate: Number(prev[5]?.value ?? 0),
  };

  const pctChange = (a: number, b: number) => b > 0 ? ((a - b) / b) * 100 : 0;

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
    eventCount: c.eventCount,
    eventCountPctChange: pctChange(c.eventCount, p.eventCount),
    avgSessionDuration: c.avgSessionDuration,
    avgSessionDurationPctChange: pctChange(c.avgSessionDuration, p.avgSessionDuration),
    bounceRate: c.bounceRate * 100,
    bounceRatePctChange: pctChange(c.bounceRate, p.bounceRate),
    topCountries: parseRows(countryData, "country", "activeUsers"),
    trafficSources: parseRows(trafficData, "source", "sessions"),
    topPages: parseRows(pageData, "page", "views"),
    devices: parseRows(deviceData, "device", "users"),
    topReferrals: parseRows(referralData, "referrer", "sessions"),
    topLandingPages: parseRows(landingData, "page", "sessions"),
  };
}
