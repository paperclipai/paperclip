# ADR: IRWIN/CAD Integration — Push vs. Poll Model

**Issue:** [IUN-2725](/IUN/issues/IUN-2725)
**Date:** 2026-09-13
**Status:** Proposed

---

## Context

Solaris FRS must export fire incident data to IRWIN (Integrated Reporting of Wildland-fire Information) and agency CAD systems as a v1.1 requirement for USFS/BLM/CALFIRE GTM. This ADR decides the data flow model for that integration.

---

## Decision: Push (Solaris → IRWIN)

Solaris will **push** incident data to IRWIN via REST API POST at incident creation time. An outbox queue (`irwin_export_queue`) decouples alert ingestion from export, providing retry, audit, and backpressure.

---

## Rationale

### Why Push Wins

| Factor | Push (Solaris → IRWIN) | Poll (IRWIN queries Solaris) |
|---|---|---|
| IRWIN protocol | IRWIN expects vendors to POST new incidents | IRWIN has no inbound webhook / subscriber mechanism |
| Latency | Near-real-time; triggered on alert creation | Depends on poll interval; adds minutes of lag |
| Agency operations | Agencies act on IRWIN data in CAD/dispatch tools | Agencies cannot wait for a poll cycle during active fire |
| Auth complexity | Solaris holds one OAuth2 client_credentials token per agency | Would require IRWIN to authenticate to Solaris — no mechanism exists |
| Failure isolation | Queue absorbs outages; retry is deterministic | Poll during outage silently skips events |

### Why Poll Is Not Viable

IRWIN does not expose a subscriber or webhook mechanism for third-party fire information systems. The IRWIN REST API (`https://irwin.doi.gov/api/`) accepts `POST /incidents` and `PATCH /incidents/{irwinId}` from authorized vendors — it does not poll external systems for new events.

---

## Architecture

```
Solaris Alert Created
        │
        ▼
 alert_classifier()  ─── severity=critical + geo data → classification=reportable
        │                                    └── otherwise → classification=informational
        ▼
 irwin_export_queue INSERT (status=pending)
        │
        ▼
 IrwinExportWorker (30s poll, exponential backoff)
        │── POST /incidents  (IRS209_Fire payload)
        │── PATCH /incidents/{id}  (situation report updates)
        └── status → success | failed (retry ≤ 5, then dead-letter alert)
```

**Token management:** A per-agency OAuth2 `client_credentials` token is cached in memory with a 5-minute pre-expiry refresh. Agency credentials are stored in `company_secrets` under key `irwin_client_id` / `irwin_client_secret`.

---

## CAD Integration Model

CAD systems (Tyler New World, Hexagon HxGN OnCall) typically ingest fire incident data via:

1. **REST webhook** — Solaris POSTs a JSON payload to an agency-configured endpoint when a reportable incident is created or updated. Most modern CAD platforms (Tyler 2020+, Hexagon 8.x+) support inbound REST webhooks. **Recommended for new deployments.**

2. **SFTP file drop** — Solaris writes an XML or JSON file (in NIEM-CF format) to an agency-hosted SFTP server on a configurable schedule. Required by some legacy CAD deployments (Tyler pre-2020, Hexagon legacy, TriTech/Motorola PremierOne). File naming convention: `solaris_incident_{YYYYMMDD_HHmmss}_{incidentId}.json`.

3. **CAD-to-CAD** — Direct TCP/IP connection using NENA standards or vendor-proprietary broker. Requires dedicated network access and is out of scope for v1.1.

**Decision for v1.1:** Support both REST webhook and SFTP file drop. Agency onboarding selects the integration type; Solaris adapts its export adapter accordingly.

---

## CAD Vendor Research

### Tyler Technologies New World CAD
- **Protocol:** REST JSON over HTTPS + optional SFTP XML import
- **Data format:** NENA NG911 (JSON), optional NIEM-CF XML for batch import
- **Auth:** OAuth2 or API key per agency deployment
- **Real-time:** REST webhook (inbound) or WebSocket subscription (read-only, Solaris would need to ingest)
- **Integration contacts:** Tyler DTS integration team via customer portal
- **Notes:** v2021+ required for REST webhook support; older versions need SFTP

### Hexagon Safety & Infrastructure (HxGN OnCall Dispatch)
- **Protocol:** REST JSON + real-time WebSocket for active incident feed
- **Data format:** Hexagon Incident Data Exchange (IDE) JSON schema or NIEM-CF
- **Auth:** OAuth2 PKCE (enterprise SSO) or API key
- **Real-time:** inbound REST webhook or CAD-to-CAD via Hexagon broker
- **Integration contacts:** Hexagon PS Integration team; requires enterprise partner agreement
- **Notes:** Hexagon supports GeoJSON geometry natively — PointOfOrigin + PerimeterPolygon map directly

### Motorola Solutions PremierOne CAD (formerly TriTech)
- **Protocol:** REST JSON or XML over HTTPS; older deployments use file-based SFTP
- **Data format:** Motorola CAD integration XML schema or NIEM-CF
- **Auth:** API key (HMAC-signed requests) or mTLS for agency deployments
- **Real-time:** REST endpoint (inbound); no persistent WebSocket for vendor push
- **Notes:** CALFIRE uses PremierOne at several units; file-based SFTP import is most commonly configured

---

## IRWIN REST API Protocol

### Base URL
`https://irwin.doi.gov/api/v2/` (production)
`https://irwin-test.doi.gov/api/v2/` (sandbox — requires agency test credentials)

### Authentication
IRWIN uses OAuth2 `client_credentials` flow:
```http
POST https://irwin.doi.gov/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id={agency_client_id}
&client_secret={agency_client_secret}
&scope=irwin:write
```
Response: `{ "access_token": "...", "expires_in": 3600, "token_type": "Bearer" }`

Agency credentials are issued by BIA/NIFC upon execution of the IRWIN Data-Sharing Agreement. **Board action required** to initiate credential request for USFS, BLM, and CALFIRE pilot agencies.

### Key Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/incidents` | Create new incident (IRS209_Fire) |
| GET | `/incidents/{irwinId}` | Fetch incident by IRWIN UUID |
| PATCH | `/incidents/{irwinId}` | Update existing incident (size, containment, etc.) |
| POST | `/incidents/{irwinId}/situationReports` | File a new ICS-209 situation report |
| GET | `/incidents?state=CA&updatedAfter=ISO8601` | Query incidents by state/date |

### IRS209_Fire Object (POST /incidents payload)

```json
{
  "IncidentName": "string",
  "IncidentNumber": "string",
  "IncidentTypeCategory": "WF|WFU|RX",
  "FireDiscoveryDateTime": "ISO8601",
  "POOLatitude": 37.123,
  "POOLongitude": -119.456,
  "POOState": "CA",
  "POOCounty": "Fresno",
  "POOLandOwner": "USFS|BLM|STATE|PRIVATE",
  "POOProtectionKindCategory": "CALFIRE|USFS|BLM|NPS",
  "PrimaryFuelModel": "SH|GR|TU|...",
  "IncidentSize": 0.0,
  "FireCause": 1,
  "IsMultiJurisdictional": false,
  "InitialLatitude": 37.123,
  "InitialLongitude": -119.456,
  "Geospatial_Incident": {
    "PointOfOrigin": { "type": "Point", "coordinates": [-119.456, 37.123] },
    "PerimeterPolygon": null
  },
  "IrwinID": null
}
```
`IrwinID` is null on creation; IRWIN assigns and returns it in the 201 response.

---

## Solaris → IRWIN Field Mapping

| Solaris (`solaris_alerts`) | IRWIN Field | Notes |
|---|---|---|
| `title` | `IncidentName` | Direct |
| `cap_identifier` | `IncidentNumber` | CAP ID format needs prefix normalization |
| `created_at` | `FireDiscoveryDateTime` | UTC ISO8601 |
| `severity = critical` | `IncidentTypeCategory = WF` | Only critical alerts are reportable as wildfire |
| `severity ≠ critical` | classification = `informational` | Not posted to IRWIN |
| `incident_area` (text) | `POOState`, `POOCounty` | **Requires geocoding** — current field is free text |
| *(missing)* | `POOLatitude` / `POOLongitude` | Must add `geo_point` to `solaris_alerts` |
| *(missing)* | `IncidentSize` | Must add `incident_size_acres` to `solaris_alerts` |
| *(missing)* | `FireCause` | Must add `fire_cause_code` (NWCG enum) |
| *(missing)* | `POOProtectionKindCategory` | Must add `protecting_agency` |
| *(missing)* | `PrimaryFuelModel` | Derivable from FRS fuel data (follow-on) |

**Gap summary:** Solaris alerts lack geospatial fields required for IRWIN. Follow-on sprint must add `geo_point`, `incident_size_acres`, `fire_cause_code`, and `protecting_agency` to `solaris_alerts` before live IRWIN submission is possible.

---

## Reportable vs. Informational Classification

| Solaris Alert Type | IRWIN Classification | Rationale |
|---|---|---|
| `severity=critical` + lat/lng present | `reportable` | Confirmed fire event with geospatial anchor |
| `severity=critical` + no lat/lng | `informational` | Cannot satisfy IRWIN `POOLatitude` requirement |
| `severity=warning` | `informational` | Fire weather/risk conditions — not an incident |
| `severity=info` | `informational` | Advisory/status — not an incident |

Classification logic lives in `alert_classifier()` at alert creation time, before the queue insert.

---

## Proof-of-Concept Auth Flow (Synthetic)

Since sandbox credentials require agency sign-off, the PoC documents the expected flow and validates it against the IRWIN test endpoint structure:

```typescript
// Expected request (cannot execute without credentials)
const tokenRes = await fetch("https://irwin-test.doi.gov/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.IRWIN_CLIENT_ID!,
    client_secret: process.env.IRWIN_CLIENT_SECRET!,
    scope: "irwin:write",
  }),
});
const { access_token } = await tokenRes.json();

const incidentRes = await fetch("https://irwin-test.doi.gov/api/v2/incidents", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(buildIRS209FirePayload(alert)),
});
// 201 Created → { IrwinID: "...", IncidentNumber: "..." }
```

**Board action needed:** Request IRWIN test credentials from NIFC/BIA (`wildfireresponse@firenet.gov`) to validate the sandbox endpoint. Reference: NWCG IRWIN Integration Program.

---

## Consequences

- **irwin_export_queue** table introduced this sprint (migration 0079).
- Solaris alert schema requires geospatial enrichment in follow-on sprint before first live IRWIN POST.
- Board must execute IRWIN Data-Sharing Agreements with USFS, BLM, CALFIRE for production credentials.
- CAD integration v1 supports REST webhook + SFTP file drop; CAD-to-CAD deferred to v1.2.
