import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findEmail, searchDomain, verifyEmail, discoverDomain, enrichCompany, enrichPerson, enrichCombined, getAccountInfo } from "./client.js";

export function registerTools(server: McpServer) {
  server.tool(
    "hunter_find_email",
    "Find the most likely email address for a person. Provide domain OR company name (domain preferred). Provide first+last name OR full_name OR linkedin_handle. Automatically verifies the found email. Uses 1 search credit.",
    {
      first_name: z.string().optional().describe("Person's first name"),
      last_name: z.string().optional().describe("Person's last name"),
      full_name: z.string().optional().describe("Person's full name (use if first/last not available)"),
      domain: z.string().optional().describe("Company domain e.g. 'surgicare.com' (preferred over company)"),
      company: z.string().optional().describe("Company name e.g. 'Surgicare' (used if domain unknown)"),
      linkedin_handle: z.string().optional().describe("LinkedIn profile handle (alternative to name+domain)"),
      max_duration: z.number().min(3).max(20).optional().describe("Max seconds for verification (3–20, default 10). Higher = more accurate."),
    },
    async ({ first_name, last_name, full_name, domain, company, linkedin_handle, max_duration }) => {
      const result = await findEmail({
        firstName: first_name,
        lastName: last_name,
        fullName: full_name,
        domain,
        company,
        linkedinHandle: linkedin_handle,
        maxDuration: max_duration,
      });
      if (!result.email) {
        const identifier = full_name ?? [first_name, last_name].filter(Boolean).join(" ") ?? linkedin_handle ?? "person";
        const location = domain ?? company ?? "unknown company";
        return { content: [{ type: "text", text: `No email found for ${identifier} at ${location}` }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            email: result.email,
            score: result.score,
            verification_status: result.verification?.status ?? null,
            accept_all: result.accept_all,
            position: result.position,
            company: result.company,
            domain: result.domain,
            linkedin_url: result.linkedin_url,
            phone_number: result.phone_number,
            sources: result.sources.slice(0, 3),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "hunter_search_domain",
    "Find all publicly known email addresses at a company domain. Good for finding decision makers.",
    {
      domain: z.string().describe("Company domain e.g. 'surgicare.com'"),
      limit: z.number().optional().default(10).describe("Max emails to return"),
      department: z.enum(["executive", "it", "finance", "management", "sales", "legal", "support", "hr", "marketing", "communication"]).optional(),
      seniority: z.enum(["junior", "senior", "executive"]).optional(),
    },
    async ({ domain, limit, department, seniority }) => {
      const result = await searchDomain({ domain, limit, department: department as string | undefined, seniority: seniority as string | undefined });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            organization: result.organization,
            email_pattern: result.pattern,
            accept_all: result.accept_all,
            total: result.emails.length,
            emails: result.emails.map((e) => ({
              email: e.value,
              name: [e.first_name, e.last_name].filter(Boolean).join(" "),
              position: e.position,
              seniority: e.seniority,
              department: e.department,
              confidence: e.confidence,
              verification_status: e.verification?.status ?? null,
              linkedin: e.linkedin,
              phone_number: e.phone_number,
            })),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "hunter_verify_email",
    "Verify deliverability of an email address. Uses 1 verification credit. status: valid/invalid/accept_all/webmail/disposable/unknown. result (deliverable/undeliverable/risky) is deprecated — use status.",
    {
      email: z.string().email().describe("Email address to verify"),
    },
    async ({ email }) => {
      const result = await verifyEmail(email);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            email: result.email,
            status: result.status,
            result: result.result,
            score: result.score,
            mx_records: result.mx_records,
            smtp_server: result.smtp_server,
            smtp_check: result.smtp_check,
            accept_all: result.accept_all,
            disposable: result.disposable,
            webmail: result.webmail,
            gibberish: result.gibberish,
            block: result.block,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "hunter_discover",
    "Discover decision makers and contacts at a company by domain. Returns best matching people with emails. Use before domain-search for fresh prospecting.",
    {
      domain: z.string().describe("Company domain e.g. 'surgicare.com'"),
      limit: z.number().optional().default(10).describe("Max contacts to return"),
    },
    async ({ domain, limit }) => {
      const result = await discoverDomain({ domain, limit });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            domain: result.domain,
            total: result.emails.length,
            contacts: result.emails.map((e) => ({
              email: e.value,
              name: [e.first_name, e.last_name].filter(Boolean).join(" "),
              position: e.position,
              department: e.department,
              confidence: e.confidence,
              linkedin: e.linkedin,
            })),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "hunter_enrich_company",
    "Get company details by domain: name, description, industry, size, location, social profiles. Use to personalize cold emails with company context.",
    {
      domain: z.string().describe("Company domain e.g. 'surgicare.com'"),
    },
    async ({ domain }) => {
      const result = await enrichCompany(domain);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: result.name,
            description: result.description,
            industry: result.industry,
            size: result.size,
            location: [result.city, result.state, result.country].filter(Boolean).join(", "),
            founded_year: result.founded_year,
            linkedin_url: result.linkedin_url,
            phone_number: result.phone_number,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "hunter_enrich_person",
    "Get person details by email: full name, position, seniority, department, LinkedIn, company info. Use to personalise outreach.",
    {
      email: z.string().email().describe("Person's email address"),
    },
    async ({ email }) => {
      const result = await enrichPerson(email);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: [result.first_name, result.last_name].filter(Boolean).join(" "),
            position: result.position,
            seniority: result.seniority,
            department: result.department,
            linkedin_url: result.linkedin_url,
            phone_number: result.phone_number,
            company: result.company,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "hunter_enrich_combined",
    "Get both person + company details in one call by email. Most efficient for full contact enrichment before emailing.",
    {
      email: z.string().email().describe("Person's email address"),
    },
    async ({ email }) => {
      const result = await enrichCombined(email);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  server.tool(
    "hunter_account_info",
    "Check Hunter.io remaining API credits for this month.",
    {},
    async () => {
      const result = await getAccountInfo();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
