/**
 * Integrator Registry — the marketplace of enterprise systems the AI Factory can
 * call for real. Each system declares how it authenticates and a set of actions,
 * where every action carries a real HTTP request spec (method + path + body).
 *
 * This is NOT simulated: the connector runtime (server) interpolates the spec
 * with the company's connected credentials and inputs and performs a live fetch.
 * A generic `http` connector covers any REST system not pre-modelled.
 */

export type IntegratorAuthScheme =
  | "none"
  | "bearer"
  | "basic"
  | "api_key_header"
  | "api_key_query";

export interface RegistryField {
  key: string;
  label: string;
  type?: "string" | "number" | "boolean" | "text";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
}

export interface IntegratorActionRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path appended to the base URL; supports {{field}} interpolation. */
  path: string;
  /** Static or templated query params. */
  query?: Record<string, string>;
  /** Templated JSON body (string); interpolated then parsed. */
  body?: string;
  /** Extra static/templated headers. */
  headers?: Record<string, string>;
}

export interface RegistryAction {
  key: string;
  label: string;
  description: string;
  /** Inputs the action expects (interpolated into the request). */
  fields: RegistryField[];
  request: IntegratorActionRequest;
}

export interface IntegratorAuth {
  scheme: IntegratorAuthScheme;
  /** Header to place the credential in (for header/bearer schemes). */
  header?: string;
  /** Credential format, e.g. "Bearer {{apiToken}}" or "{{apiKey}}". */
  format?: string;
  /** Query param name for api_key_query scheme. */
  queryParam?: string;
  /** Which credential/config fields to collect on connect. */
  fields: RegistryField[];
  /** Which field holds the base URL (default "baseUrl"). */
  baseUrlField?: string;
}

export interface IntegratorSystem {
  key: string;
  name: string;
  category: string;
  description: string;
  /** Lucide icon name. */
  icon: string;
  auth: IntegratorAuth;
  actions: RegistryAction[];
}

export const INTEGRATOR_CATEGORIES = [
  "ITSM",
  "HR",
  "Finance",
  "CRM",
  "Identity",
  "DevOps",
  "Collaboration",
  "Support",
  "Generic",
] as const;
export type IntegratorCategory = (typeof INTEGRATOR_CATEGORIES)[number];

const baseUrl: RegistryField = { key: "baseUrl", label: "Base URL", required: true, placeholder: "https://api.example.com" };
const bearerToken: RegistryField = { key: "apiToken", label: "API token", required: true, secret: true };

export const INTEGRATOR_REGISTRY: IntegratorSystem[] = [
  // ---- ITSM ----
  {
    key: "servicenow",
    name: "ServiceNow",
    category: "ITSM",
    description: "IT service management — incidents, requests, CMDB.",
    icon: "Server",
    auth: {
      scheme: "basic",
      fields: [{ key: "baseUrl", label: "Instance URL", required: true, placeholder: "https://acme.service-now.com" }, { key: "username", label: "Username", required: true }, { key: "password", label: "Password", required: true, secret: true }],
    },
    actions: [
      {
        key: "incident.create",
        label: "Create incident",
        description: "Open a new incident.",
        fields: [{ key: "short_description", label: "Short description", required: true }, { key: "urgency", label: "Urgency" }],
        request: { method: "POST", path: "/api/now/table/incident", body: '{"short_description":"{{short_description}}","urgency":"{{urgency}}"}' },
      },
      {
        key: "incident.get",
        label: "Get incident",
        description: "Fetch an incident by number.",
        fields: [{ key: "number", label: "Incident number", required: true, placeholder: "INC0010001" }],
        request: { method: "GET", path: "/api/now/table/incident", query: { sysparm_query: "number={{number}}", sysparm_limit: "1" } },
      },
    ],
  },
  {
    key: "jira",
    name: "Atlassian Jira",
    category: "DevOps",
    description: "Issue tracking — create, transition, comment.",
    icon: "ClipboardList",
    auth: {
      scheme: "basic",
      fields: [{ key: "baseUrl", label: "Site URL", required: true, placeholder: "https://acme.atlassian.net" }, { key: "email", label: "Account email", required: true }, { key: "apiToken", label: "API token", required: true, secret: true }],
    },
    actions: [
      {
        key: "issue.create",
        label: "Create issue",
        description: "Create an issue in a project.",
        fields: [{ key: "projectKey", label: "Project key", required: true, placeholder: "OPS" }, { key: "summary", label: "Summary", required: true }, { key: "issueType", label: "Issue type", placeholder: "Task" }],
        request: { method: "POST", path: "/rest/api/3/issue", body: '{"fields":{"project":{"key":"{{projectKey}}"},"summary":"{{summary}}","issuetype":{"name":"{{issueType}}"}}}' },
      },
      {
        key: "issue.get",
        label: "Get issue",
        description: "Fetch an issue by key.",
        fields: [{ key: "issueKey", label: "Issue key", required: true, placeholder: "OPS-123" }],
        request: { method: "GET", path: "/rest/api/3/issue/{{issueKey}}" },
      },
    ],
  },
  {
    key: "zendesk",
    name: "Zendesk",
    category: "Support",
    description: "Customer support tickets.",
    icon: "Headphones",
    auth: {
      scheme: "basic",
      fields: [{ key: "baseUrl", label: "Subdomain URL", required: true, placeholder: "https://acme.zendesk.com" }, { key: "email", label: "Agent email (append /token)", required: true, placeholder: "ops@acme.com/token" }, { key: "apiToken", label: "API token", required: true, secret: true }],
    },
    actions: [
      {
        key: "ticket.create",
        label: "Create ticket",
        description: "Open a support ticket.",
        fields: [{ key: "subject", label: "Subject", required: true }, { key: "comment", label: "Comment", required: true }],
        request: { method: "POST", path: "/api/v2/tickets.json", body: '{"ticket":{"subject":"{{subject}}","comment":{"body":"{{comment}}"}}}' },
      },
    ],
  },
  {
    key: "pagerduty",
    name: "PagerDuty",
    category: "ITSM",
    description: "Incident response and on-call.",
    icon: "BellRing",
    auth: {
      scheme: "api_key_header",
      header: "Authorization",
      format: "Token token={{apiToken}}",
      fields: [{ key: "baseUrl", label: "API URL", required: true, placeholder: "https://api.pagerduty.com" }, bearerToken],
      baseUrlField: "baseUrl",
    },
    actions: [
      {
        key: "incident.list",
        label: "List incidents",
        description: "List recent incidents.",
        fields: [],
        request: { method: "GET", path: "/incidents", query: { limit: "10" }, headers: { Accept: "application/vnd.pagerduty+json;version=2" } },
      },
    ],
  },
  // ---- HR ----
  {
    key: "workday",
    name: "Workday",
    category: "HR",
    description: "HCM — workers, org, time off.",
    icon: "CalendarClock",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer {{apiToken}}",
      fields: [{ key: "baseUrl", label: "API base URL", required: true, placeholder: "https://acme.workday.com/ccx/api/v1" }, bearerToken],
    },
    actions: [
      {
        key: "worker.get",
        label: "Get worker",
        description: "Fetch a worker by id.",
        fields: [{ key: "workerId", label: "Worker ID", required: true }],
        request: { method: "GET", path: "/workers/{{workerId}}" },
      },
    ],
  },
  {
    key: "bamboohr",
    name: "BambooHR",
    category: "HR",
    description: "HRIS — employees, time off, onboarding.",
    icon: "Users",
    auth: {
      scheme: "basic",
      fields: [{ key: "baseUrl", label: "API URL", required: true, placeholder: "https://api.bamboohr.com/api/gateway.php/acme" }, { key: "apiKey", label: "API key", required: true, secret: true }, { key: "password", label: "Password (use 'x')", placeholder: "x" }],
    },
    actions: [
      {
        key: "employee.get",
        label: "Get employee",
        description: "Fetch an employee directory entry.",
        fields: [{ key: "employeeId", label: "Employee ID", required: true }],
        request: { method: "GET", path: "/v1/employees/{{employeeId}}", query: { fields: "firstName,lastName,workEmail,department" }, headers: { Accept: "application/json" } },
      },
    ],
  },
  // ---- Finance ----
  {
    key: "netsuite",
    name: "NetSuite",
    category: "Finance",
    description: "ERP — invoices, vendors, GL.",
    icon: "DollarSign",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer {{apiToken}}",
      fields: [{ key: "baseUrl", label: "REST URL", required: true, placeholder: "https://ACCT.suitetalk.api.netsuite.com/services/rest" }, bearerToken],
    },
    actions: [
      {
        key: "invoice.get",
        label: "Get invoice",
        description: "Fetch an invoice record.",
        fields: [{ key: "invoiceId", label: "Invoice ID", required: true }],
        request: { method: "GET", path: "/record/v1/invoice/{{invoiceId}}" },
      },
    ],
  },
  {
    key: "coupa",
    name: "Coupa",
    category: "Finance",
    description: "Procurement — requisitions, POs, suppliers.",
    icon: "ShoppingCart",
    auth: {
      scheme: "api_key_header",
      header: "X-COUPA-API-KEY",
      format: "{{apiKey}}",
      fields: [{ key: "baseUrl", label: "Instance URL", required: true, placeholder: "https://acme.coupahost.com" }, { key: "apiKey", label: "API key", required: true, secret: true }],
    },
    actions: [
      {
        key: "requisition.create",
        label: "Create requisition",
        description: "Raise a purchase requisition.",
        fields: [{ key: "description", label: "Description", required: true }],
        request: { method: "POST", path: "/api/requisitions", headers: { Accept: "application/json" }, body: '{"requisition-lines":[{"description":"{{description}}"}]}' },
      },
    ],
  },
  // ---- CRM ----
  {
    key: "salesforce",
    name: "Salesforce",
    category: "CRM",
    description: "CRM — accounts, contacts, cases.",
    icon: "Cloud",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer {{apiToken}}",
      fields: [{ key: "baseUrl", label: "Instance URL", required: true, placeholder: "https://acme.my.salesforce.com" }, bearerToken],
    },
    actions: [
      {
        key: "query",
        label: "SOQL query",
        description: "Run a SOQL query.",
        fields: [{ key: "soql", label: "SOQL", required: true, placeholder: "SELECT Id,Name FROM Account LIMIT 5" }],
        request: { method: "GET", path: "/services/data/v60.0/query", query: { q: "{{soql}}" } },
      },
    ],
  },
  {
    key: "hubspot",
    name: "HubSpot",
    category: "CRM",
    description: "CRM and marketing.",
    icon: "Cloud",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer {{apiToken}}",
      fields: [{ key: "baseUrl", label: "API URL", placeholder: "https://api.hubapi.com" }, bearerToken],
      baseUrlField: "baseUrl",
    },
    actions: [
      {
        key: "contact.list",
        label: "List contacts",
        description: "List CRM contacts.",
        fields: [],
        request: { method: "GET", path: "/crm/v3/objects/contacts", query: { limit: "10" } },
      },
    ],
  },
  // ---- Identity ----
  {
    key: "okta",
    name: "Okta",
    category: "Identity",
    description: "Identity — users, groups, apps.",
    icon: "KeyRound",
    auth: {
      scheme: "api_key_header",
      header: "Authorization",
      format: "SSWS {{apiToken}}",
      fields: [{ key: "baseUrl", label: "Org URL", required: true, placeholder: "https://acme.okta.com" }, bearerToken],
    },
    actions: [
      {
        key: "user.get",
        label: "Get user",
        description: "Fetch a user by login or id.",
        fields: [{ key: "user", label: "User id or login", required: true }],
        request: { method: "GET", path: "/api/v1/users/{{user}}" },
      },
    ],
  },
  {
    key: "sailpoint",
    name: "SailPoint",
    category: "Identity",
    description: "Identity governance — access, accounts.",
    icon: "KeyRound",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer {{apiToken}}",
      fields: [{ key: "baseUrl", label: "Tenant URL", required: true, placeholder: "https://acme.api.identitynow.com" }, bearerToken],
    },
    actions: [
      {
        key: "account.list",
        label: "List accounts",
        description: "List identity accounts.",
        fields: [],
        request: { method: "GET", path: "/v3/accounts", query: { limit: "10" } },
      },
    ],
  },
  // ---- DevOps ----
  {
    key: "github",
    name: "GitHub",
    category: "DevOps",
    description: "Repos, issues, pull requests.",
    icon: "Github",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer {{apiToken}}",
      fields: [{ key: "baseUrl", label: "API URL", placeholder: "https://api.github.com" }, bearerToken],
      baseUrlField: "baseUrl",
    },
    actions: [
      {
        key: "issue.create",
        label: "Create issue",
        description: "Open an issue in a repo.",
        fields: [{ key: "owner", label: "Owner", required: true }, { key: "repo", label: "Repo", required: true }, { key: "title", label: "Title", required: true }, { key: "body", label: "Body" }],
        request: { method: "POST", path: "/repos/{{owner}}/{{repo}}/issues", headers: { Accept: "application/vnd.github+json" }, body: '{"title":"{{title}}","body":"{{body}}"}' },
      },
      {
        key: "repo.get",
        label: "Get repo",
        description: "Fetch repository metadata.",
        fields: [{ key: "owner", label: "Owner", required: true }, { key: "repo", label: "Repo", required: true }],
        request: { method: "GET", path: "/repos/{{owner}}/{{repo}}", headers: { Accept: "application/vnd.github+json" } },
      },
    ],
  },
  // ---- Collaboration ----
  {
    key: "slack",
    name: "Slack",
    category: "Collaboration",
    description: "Messaging — post and read messages.",
    icon: "MessageSquare",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer {{apiToken}}",
      fields: [{ key: "baseUrl", label: "API URL", placeholder: "https://slack.com/api" }, bearerToken],
      baseUrlField: "baseUrl",
    },
    actions: [
      {
        key: "chat.postMessage",
        label: "Post message",
        description: "Send a message to a channel.",
        fields: [{ key: "channel", label: "Channel ID", required: true }, { key: "text", label: "Text", required: true }],
        request: { method: "POST", path: "/chat.postMessage", headers: { "Content-Type": "application/json; charset=utf-8" }, body: '{"channel":"{{channel}}","text":"{{text}}"}' },
      },
    ],
  },
  {
    key: "confluence",
    name: "Confluence",
    category: "Collaboration",
    description: "Knowledge base — pages and search.",
    icon: "BookOpen",
    auth: {
      scheme: "basic",
      fields: [{ key: "baseUrl", label: "Site URL", required: true, placeholder: "https://acme.atlassian.net/wiki" }, { key: "email", label: "Account email", required: true }, { key: "apiToken", label: "API token", required: true, secret: true }],
    },
    actions: [
      {
        key: "search",
        label: "Search content",
        description: "Search the knowledge base.",
        fields: [{ key: "cql", label: "CQL", required: true, placeholder: 'text ~ "vpn"' }],
        request: { method: "GET", path: "/rest/api/content/search", query: { cql: "{{cql}}", limit: "10" } },
      },
    ],
  },
  // ---- Generic ----
  {
    key: "http",
    name: "HTTP Connector",
    category: "Generic",
    description: "Call any REST API. Use when there is no pre-built connector.",
    icon: "Globe",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer {{apiToken}}",
      fields: [{ key: "baseUrl", label: "Base URL", required: true, placeholder: "https://api.example.com" }, { key: "apiToken", label: "Bearer token (optional)", secret: true }],
    },
    actions: [
      {
        key: "request",
        label: "Send request",
        description: "Send an arbitrary request to the base URL + path.",
        fields: [
          { key: "method", label: "Method", placeholder: "GET" },
          { key: "path", label: "Path", required: true, placeholder: "/v1/things" },
          { key: "body", label: "JSON body", type: "text" },
        ],
        request: { method: "GET", path: "{{path}}" },
      },
    ],
  },
];

const REGISTRY_BY_KEY = new Map(INTEGRATOR_REGISTRY.map((s) => [s.key, s]));

export function getIntegratorSystem(key: string): IntegratorSystem | undefined {
  return REGISTRY_BY_KEY.get(key);
}

export function getRegistryAction(systemKey: string, actionKey: string): RegistryAction | undefined {
  return getIntegratorSystem(systemKey)?.actions.find((a) => a.key === actionKey);
}
