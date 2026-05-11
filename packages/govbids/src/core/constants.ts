/**
 * 7 keyword search strings for HigherGov, each targeting a ConsultAdd service area.
 * Run as separate saved searches and deduplicate results.
 * The `-federal -defense` exclusions filter out federal pass-throughs in state/local results.
 */
export const KEYWORD_SEARCHES = [
  // Search 1 — Managed IT Services / MSP
  '("managed services" OR "IT managed services" OR "managed security" OR "IT infrastructure management" OR "help desk" OR "IT support services" OR "IT outsourcing") -federal -defense',

  // Search 2 — Cybersecurity
  '("cybersecurity" OR "cyber security" OR "information security" OR "network security" OR "security operations center" OR "SOC" OR "vulnerability assessment" OR "penetration testing" OR "SIEM" OR "incident response" OR "security monitoring") -federal -defense',

  // Search 3 — Artificial Intelligence / Data
  '("artificial intelligence" OR "machine learning" OR "AI" OR "predictive analytics" OR "data analytics" OR "natural language processing" OR "automation" OR "intelligent automation" OR "RPA" OR "robotic process automation") -federal -defense',

  // Search 4 — Cloud & Infrastructure
  '("cloud migration" OR "cloud services" OR "AWS" OR "Azure" OR "cloud hosting" OR "cloud infrastructure" OR "IaaS" OR "PaaS" OR "SaaS implementation") -federal -defense',

  // Search 5 — ERP / Enterprise Systems
  '("Oracle" OR "SAP" OR "ERP" OR "enterprise resource planning" OR "Microsoft Dynamics" OR "Salesforce" OR "system integration" OR "systems implementation") -federal -defense',

  // Search 6 — Application Development / Modernization
  '("application development" OR "software development" OR "custom software" OR "legacy modernization" OR "digital transformation" OR "application modernization" OR "web application" OR "system modernization") -federal -defense',

  // Search 7 — General Professional IT Services
  '("IT consulting" OR "technology consulting" OR "IT professional services" OR "IT staffing" OR "staff augmentation" OR "IT advisory") -federal -defense',
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
 */
export const DEFAULT_MIN_SCORE = 60;

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
} as const;

/**
 * HigherGov API base URL.
 */
export const HIGHERGOV_API_BASE_URL = "https://www.highergov.com/api-external/";
