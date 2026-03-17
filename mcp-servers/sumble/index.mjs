#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = "https://api.sumble.com/v4";
const API_KEY = process.env.SUMBLE_API_KEY;

if (!API_KEY) {
  console.error("SUMBLE_API_KEY environment variable is required");
  process.exit(1);
}

async function sumbleRequest(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sumble API ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "sumble",
  version: "1.0.0",
});

// --- People Find ---
server.tool(
  "sumble_find_people",
  "Find people at a company by domain, role, and seniority. Returns name, title, LinkedIn URL, location. Costs 1 credit per person returned.",
  {
    domain: z.string().describe("Company domain (e.g. 'acme.com')"),
    job_functions: z.array(z.string()).optional().describe("Filter by job function: Engineer, Executive, Sales, Marketing, Finance, HR, Operations, Legal, Design, Product, Support, Data, etc."),
    job_levels: z.array(z.string()).optional().describe("Filter by seniority: Junior, Senior, Manager, Director, VP, C-Level, Founder"),
    countries: z.array(z.string()).optional().describe("Country codes: US, MX, CA, etc."),
    query: z.string().optional().describe("Free-text query to filter people (alternative to structured filters)"),
    limit: z.number().min(1).max(50).default(10).describe("Max results (1-50, default 10). Each person costs 1 credit."),
  },
  async ({ domain, job_functions, job_levels, countries, query, limit }) => {
    const filters = query
      ? { query }
      : {
          ...(job_functions?.length && { job_functions }),
          ...(job_levels?.length && { job_levels }),
          ...(countries?.length && { countries }),
        };

    const data = await sumbleRequest("/people/find", {
      organization: { domain },
      filters,
      limit,
    });

    const people = (data.people || []).map((p) => ({
      name: p.name,
      title: p.job_title,
      function: p.job_function,
      level: p.job_level,
      location: p.location,
      country: p.country_code,
      linkedin: p.linkedin_url,
      started: p.start_date,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              organization: data.organization?.name,
              domain: data.organization?.domain,
              total_people: data.people_count,
              credits_used: data.credits_used,
              credits_remaining: data.credits_remaining,
              results: people,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// --- Organizations Find ---
server.tool(
  "sumble_find_organizations",
  "Search for companies by technology, category, or free-text query. Returns company name, domain, employee count, HQ, industry. Costs 5 credits per result.",
  {
    technologies: z.array(z.string()).optional().describe("Filter by technologies used (e.g. 'salesforce', 'hubspot', 'shopify')"),
    technology_categories: z.array(z.string()).optional().describe("Filter by tech category (e.g. 'CRM', 'E-commerce', 'Analytics')"),
    query: z.string().optional().describe("Free-text search query for companies"),
    order_by: z.enum(["employee_count", "industry", "jobs_count", "people_count"]).optional().describe("Sort results by field"),
    limit: z.number().min(1).max(50).default(10).describe("Max results (1-50, default 10). Each org costs 5 credits."),
  },
  async ({ technologies, technology_categories, query, order_by, limit }) => {
    const body = {
      filters: query
        ? { query }
        : {
            ...(technologies?.length && { technologies }),
            ...(technology_categories?.length && { technology_categories }),
          },
      limit,
    };
    if (order_by) {
      body.order_by_column = order_by;
      body.order_by_direction = "DESC";
    }

    const data = await sumbleRequest("/organizations/find", body);

    const orgs = (data.organizations || []).map((o) => ({
      name: o.name,
      domain: o.domain,
      slug: o.slug,
      hq: o.headquarters,
      employees: o.employee_count,
      industry: o.industry,
      people_count: o.people_count,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total: data.organizations_count,
              credits_used: data.credits_used,
              credits_remaining: data.credits_remaining,
              results: orgs,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// --- Organization Enrich ---
server.tool(
  "sumble_enrich_organization",
  "Get detailed info about a specific company including technologies used. Costs 5 credits per technology matched.",
  {
    domain: z.string().describe("Company domain (e.g. 'acme.com')"),
    technologies: z.array(z.string()).optional().describe("Filter to specific technologies to check"),
  },
  async ({ domain, technologies }) => {
    const body = {
      organization: { domain },
      ...(technologies?.length && { filters: { technologies } }),
    };
    const data = await sumbleRequest("/organizations/enrich", body);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name: data.organization?.name,
              domain: data.organization?.domain,
              hq: data.organization?.headquarters,
              employees: data.organization?.employee_count,
              industry: data.organization?.industry,
              technologies: data.technologies,
              credits_used: data.credits_used,
              credits_remaining: data.credits_remaining,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// --- Jobs Find ---
server.tool(
  "sumble_find_jobs",
  "Find job postings at a company. Useful for identifying hiring signals and growth areas. Costs 3 credits per job.",
  {
    domain: z.string().describe("Company domain"),
    query: z.string().optional().describe("Search query to filter jobs"),
    limit: z.number().min(1).max(50).default(10).describe("Max results (default 10). Each job costs 3 credits."),
  },
  async ({ domain, query, limit }) => {
    const data = await sumbleRequest("/jobs/find", {
      organization: { domain },
      filters: query ? { query } : {},
      limit,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              organization: data.organization?.name,
              total_jobs: data.jobs_count,
              credits_used: data.credits_used,
              credits_remaining: data.credits_remaining,
              jobs: data.jobs,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
