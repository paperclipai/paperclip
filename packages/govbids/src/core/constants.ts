/**
 * 11 keyword search strings for HigherGov, each targeting a ConsultAdd service area.
 * Run as separate saved searches and deduplicate results.
 * The `-federal -defense` exclusions filter out federal pass-throughs in state/local results.
 *
 * Searches 9-11 added 2026-05-27 after coverage audit on 193 manual team RFPs
 * identified gaps in: AI Platform variants, asset/CMMS/case-management systems,
 * HRIS/Workday/IAM platforms, and named-platform vendor terms.
 */
export const KEYWORD_SEARCHES = [
  // Search 1 — Managed IT Services / MSP
  '("managed services" OR "IT managed services" OR "managed security" OR "IT infrastructure management" OR "help desk" OR "IT support services" OR "IT outsourcing" OR "managed service provider" OR "MSP") -federal -defense',

  // Search 2 — Cybersecurity
  '("cybersecurity" OR "cyber security" OR "information security" OR "network security" OR "security operations center" OR "SOC" OR "vulnerability assessment" OR "penetration testing" OR "SIEM" OR "incident response" OR "security monitoring" OR "MDR" OR "managed detection and response" OR "MSSP") -federal -defense',

  // Search 3 — Artificial Intelligence / Data (broadened with platform variants)
  '("artificial intelligence" OR "machine learning" OR "AI platform" OR "AI solution" OR "AI services" OR "enterprise AI" OR "predictive analytics" OR "data analytics" OR "data platform" OR "data engineering" OR "natural language processing" OR "automation" OR "intelligent automation" OR "RPA" OR "robotic process automation" OR "AI governance" OR "AI strategy") -federal -defense',

  // Search 4 — Cloud & Infrastructure
  '("cloud migration" OR "cloud services" OR "AWS" OR "Azure" OR "cloud hosting" OR "cloud infrastructure" OR "IaaS" OR "PaaS" OR "SaaS implementation" OR "SaaS migration" OR "cloud platform") -federal -defense',

  // Search 5 — ERP / Enterprise Systems
  '("Oracle" OR "SAP" OR "ERP" OR "enterprise resource planning" OR "Microsoft Dynamics" OR "Salesforce" OR "Workday" OR "PeopleSoft" OR "system integration" OR "systems implementation" OR "information system" OR "management system" OR "system replacement" OR "system modernization" OR "system upgrade" OR "system implementation" OR "enterprise system" OR "case management system" OR "permitting system" OR "financial system" OR "utility billing system") -federal -defense',

  // Search 6 — Application Development / Modernization
  '("application development" OR "software development" OR "custom software" OR "legacy modernization" OR "legacy system" OR "digital transformation" OR "application modernization" OR "web application" OR "system modernization" OR "mobile application" OR "API development") -federal -defense',

  // Search 7 — General Professional IT Services
  '("IT consulting" OR "technology consulting" OR "IT professional services" OR "IT staffing" OR "staff augmentation" OR "IT advisory" OR "technology services" OR "information technology services" OR "IT director" OR "IT strategy") -federal -defense',

  // Search 8 — Software Licensing / Subscriptions / Maintenance Renewals
  '("software license" OR "software licensing" OR "licensing" OR "subscription" OR "SaaS" OR "license renewal" OR "software maintenance" OR "maintenance and support renewal" OR "maintenance and support" OR "enterprise license agreement" OR "ELA" OR "software subscription" OR "annual maintenance" OR "premier support" OR "premium support") -federal -defense',

  // Search 9 — Asset / Facility / CMMS / GIS Systems (new 2026-05-27)
  // Catches the asset-management & CMMS misses (Wyoming asset platform, SCADA CMMS, ESRI/ArcGIS, Trimble Unity, telecom infra, bridge mgmt)
  '("asset management" OR "asset management system" OR "asset management platform" OR "CMMS" OR "computerized maintenance management" OR "EAM" OR "enterprise asset management" OR "GIS" OR "geographic information system" OR "ArcGIS" OR "ESRI" OR "Trimble" OR "SCADA" OR "infrastructure management" OR "telecommunications infrastructure" OR "facility management system") -federal -defense',

  // Search 10 — People / HR / IAM / Workforce Systems (new 2026-05-27)
  // Catches HRIS / Workday / OneLogin / MFA / time-and-attendance / paid-leave platform RFPs
  '("HRIS" OR "human resources information system" OR "human capital management" OR "Workday" OR "Workday augmentation" OR "identity and access management" OR "IAM" OR "OneLogin" OR "Okta" OR "multi-factor authentication" OR "MFA" OR "single sign-on" OR "SSO" OR "time and attendance" OR "absence management" OR "paid family leave" OR "workforce management") -federal -defense',

  // Search 11 — Named Platforms / Vendor Services (new 2026-05-27)
  // Catches named-platform RFPs: ServiceNow, VMware, Microsoft, Adobe, Barracuda, Procore, Drupal, Cisco Meraki, Recorded Future, etc.
  '("ServiceNow" OR "VMware" OR "Microsoft 365" OR "M365" OR "Office 365" OR "SharePoint" OR "Microsoft Fabric" OR "Microsoft Dynamics 365" OR "Adobe Creative Cloud" OR "Barracuda" OR "Procore" OR "Cisco Meraki" OR "Drupal" OR "Kentico" OR "Salesforce platform" OR "Salesforce implementation" OR "Salesforce maintenance" OR "Power BI" OR "Tableau" OR "Snowflake" OR "Recorded Future") -federal -defense',
] as const;

/**
 * NAICS codes that map directly to ConsultAdd's capabilities.
 * These are the 5 core codes to always include in searches.
 */
export const NAICS_CODES = [
  "541512", // Computer Systems Design Services
  "541511", // Custom Computer Programming Services
  "541513", // Computer Facilities Management Services
  "518210", // Data Processing, Hosting, and Related Services
  "541519", // Other Computer Related Services
] as const;

/**
 * Optional NAICS codes to add if volume is too low with just the core 5.
 */
export const NAICS_CODES_EXTENDED = [
  ...NAICS_CODES,
  "541611", // Administrative Management & General Management Consulting
  "541690", // Other Scientific & Technical Consulting
] as const;

/**
 * PSC/FSC codes for IT and Telecom services.
 * HigherGov adds these to state/local opportunities even though agencies don't natively use them.
 */
export const PSC_CODES = [
  "D302", // IT & Telecom – Systems Development
  "D306", // IT & Telecom – Systems/Programming/Maintenance
  "D307", // IT & Telecom – IT Strategy and Architecture
  "D308", // IT & Telecom – Programming
  "D310", // IT & Telecom – Cyber Security
  "D311", // IT & Telecom – Internet
  "D316", // IT & Telecom – IT Management
  "D317", // IT & Telecom – Web-Based Subscription
  "D399", // IT & Telecom – Other
] as const;

/**
 * Opportunity types that are NOT biddable and should be excluded.
 * We only want active solicitations/RFPs where ConsultAdd can submit a proposal.
 */
export const NON_BIDDABLE_TYPES = [
  "Notice",
  "Special Notice",
  "RFI",
  "Request for Information",
  "Award Intent",
  "Intent to Award",
  "Award",
  "Study",
  "RFQ",
  "Request for Quotation",
  "Sell Event",
  "Sources Sought",
  "Presolicitation",
  "Justification",
  "Agendas",
  "Minutes",
  "Synopsis",
  "Amendment",
  "Modification",
  "Combined Synopsis",
] as const;

/**
 * US-4: agencies/issuers ConsultAdd cannot pursue — international bodies whose
 * work is outside US jurisdiction and follows non-US procurement rules. Matched
 * case-insensitively as whole phrases against the agency name. Observed ~41 UN
 * solicitations/day leaking in, all coerced to a US state (NY) by the region
 * parser. Word-boundary matching avoids false positives (e.g. "Union County").
 */
export const EXCLUDED_AGENCY_PATTERNS = [
  "united nations",
  "unicef",
  "unicc",
  "undp",
  "unfpa",
  "unhcr",
  "unesco",
  "unops",
  "unrwa",
  "world bank",
  "world health organization",
  "european union",
  "interpol",
  "organization of american states",
] as const;

/**
 * Contract value range sweet spot for ConsultAdd.
 */
export const VALUE_RANGE = {
  min: 100_000,
  max: 500_000,
} as const;

/**
 * Due date window: how far ahead to look for opportunities.
 */
export const DUE_DATE_RANGE = {
  minDaysFromNow: 0,
  maxDaysFromNow: 90,
} as const;

/**
 * HigherGov API quota: 10,000 records per month.
 */
export const MONTHLY_API_QUOTA = 10_000;

/**
 * Default page size for API requests.
 */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Default minimum score for an opportunity to be considered qualified.
 * Lowered 60 → 50 on 2026-05-27 after coverage audit: 34 RFPs the manual team
 * sourced from May 12–22 sat in our 50–59 band, just under the old cut. Tier
 * column in the lawyer Excel still distinguishes GREEN ≥80 / YELLOW 70-79 /
 * AMBER 50-69 so the team can prioritize.
 */
export const DEFAULT_MIN_SCORE = 50;

/**
 * Default Claude model for scoring.
 */
export const DEFAULT_SCORER_MODEL = "claude-sonnet-4-20250514";

/**
 * Default concurrency for batch scoring.
 */
export const DEFAULT_SCORER_CONCURRENCY = 5;

/**
 * Service category labels for display.
 */
export const SERVICE_CATEGORY_LABELS: Record<string, string> = {
  "managed-it": "Managed IT Services",
  cybersecurity: "Cybersecurity",
  "ai-data": "AI & Data Analytics",
  cloud: "Cloud & Infrastructure",
  erp: "ERP / Enterprise Systems",
  "app-dev": "Application Development",
  "it-staffing": "IT Staffing / Staff Augmentation",
  mixed: "Mixed / Multiple Categories",
} as const;

/**
 * HubSpot pipeline stages for government opportunities.
 */
export const HUBSPOT_PIPELINE_STAGES = {
  new: "New",
  qualified: "Qualified",
  proposalInProgress: "Proposal In Progress",
  submitted: "Submitted",
  won: "Won",
  lost: "Lost",
} as const;

/**
 * HubSpot pipeline name.
 */
export const HUBSPOT_PIPELINE_NAME = "Government Opportunities";

/**
 * ConsultAdd certifications for competitive position scoring.
 */
export const CONSULTADD_CERTIFICATIONS = [
  "USPAACC",
  "MBE",
] as const;

/**
 * Environment variable names for API keys.
 */
export const ENV_VARS = {
  higherGovApiKey: "HIGHERGOV_API_KEY",
  claudeApiKey: "ANTHROPIC_API_KEY",
  hubspotApiKey: "HUBSPOT_API_KEY",
  bidPrimeApiToken: "BIDPRIME_API_TOKEN",
  slackBotToken: "SLACK_BOT_TOKEN",
  slackChannel: "SLACK_CHANNEL",
  slackChannelId: "SLACK_CHANNEL_ID",
  bidPrimeUserId: "BIDPRIME_USER_ID",
  bidPrimeSessionFile: "BIDPRIME_SESSION_FILE",
} as const;

/**
 * HigherGov API base URL.
 */
export const HIGHERGOV_API_BASE_URL = "https://www.highergov.com/api-external/";
