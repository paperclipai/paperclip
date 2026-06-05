import { HUBSPOT_PIPELINE_NAME, HUBSPOT_PIPELINE_STAGES } from "./constants.js";
import type { ScoredOpportunity } from "./types.js";

interface HubSpotClientOptions {
  apiKey: string;
  pipelineId?: string;
}

interface HubSpotDealResult {
  id: string;
  properties: Record<string, string>;
}

interface CreateDealsResult {
  created: HubSpotDealResult[];
  skipped: string[];
  errors: Array<{ id: string; error: string }>;
}

const HUBSPOT_API_BASE = "https://api.hubapi.com";

/**
 * HubSpot API client for pushing qualified government opportunities as Deals.
 */
export class HubSpotClient {
  private readonly apiKey: string;
  private pipelineId: string | null;

  constructor(options: HubSpotClientOptions) {
    this.apiKey = options.apiKey;
    this.pipelineId = options.pipelineId ?? null;
  }

  /**
   * Create a single HubSpot deal from a scored opportunity.
   */
  async createDeal(opp: ScoredOpportunity): Promise<HubSpotDealResult> {
    const pipelineId = await this.getPipelineId();

    const properties: Record<string, string> = {
      dealname: `[GovBid] ${opp.title}`.slice(0, 200),
      pipeline: pipelineId,
      dealstage: HUBSPOT_PIPELINE_STAGES.new,
      source_platform: "HigherGov",
      highergov_id: opp.id,
      naics_code: opp.naicsCode ?? "",
      psc_code: opp.pscCode ?? "",
      service_category: opp.serviceCategory,
      qualification_score: String(opp.score),
      due_date: opp.dueDate ?? "",
      agency_name: opp.agency,
      opportunity_state: opp.state ?? "",
      posting_url: opp.sourceUrl ?? "",
      certs_matched: opp.setAsideType ?? "",
    };

    if (opp.estimatedValue) {
      properties.amount = String(opp.estimatedValue);
    }
    if (opp.dueDate) {
      properties.closedate = opp.dueDate;
    }

    const response = await this.request<{ id: string; properties: Record<string, string> }>(
      "/crm/v3/objects/deals",
      {
        method: "POST",
        body: JSON.stringify({ properties }),
      },
    );

    return { id: response.id, properties: response.properties };
  }

  /**
   * Check if a deal already exists for a given HigherGov opportunity ID.
   */
  async checkDealExists(higherGovId: string): Promise<boolean> {
    try {
      const response = await this.request<{ total: number }>(
        "/crm/v3/objects/deals/search",
        {
          method: "POST",
          body: JSON.stringify({
            filterGroups: [
              {
                filters: [
                  {
                    propertyName: "highergov_id",
                    operator: "EQ",
                    value: higherGovId,
                  },
                ],
              },
            ],
            limit: 1,
          }),
        },
      );
      return response.total > 0;
    } catch {
      // If search fails (e.g., property doesn't exist yet), assume not found
      return false;
    }
  }

  /**
   * Batch create deals with duplicate checking and per-deal error handling.
   */
  async createDeals(opps: ScoredOpportunity[]): Promise<CreateDealsResult> {
    const result: CreateDealsResult = {
      created: [],
      skipped: [],
      errors: [],
    };

    for (const opp of opps) {
      try {
        const exists = await this.checkDealExists(opp.id);
        if (exists) {
          result.skipped.push(opp.id);
          continue;
        }

        const deal = await this.createDeal(opp);
        result.created.push(deal);
      } catch (error) {
        result.errors.push({
          id: opp.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  /**
   * Get the pipeline ID for "Government Opportunities", or return cached value.
   */
  private async getPipelineId(): Promise<string> {
    if (this.pipelineId) return this.pipelineId;

    try {
      const response = await this.request<{
        results: Array<{ id: string; label: string }>;
      }>("/crm/v3/pipelines/deals", { method: "GET" });

      const pipeline = response.results.find(
        (p) => p.label === HUBSPOT_PIPELINE_NAME,
      );

      if (pipeline) {
        this.pipelineId = pipeline.id;
        return pipeline.id;
      }
    } catch {
      // Fall through to default
    }

    // If pipeline not found, use "default" — user should create it in HubSpot
    this.pipelineId = "default";
    return "default";
  }

  private async request<T>(
    endpoint: string,
    init: { method: string; body?: string },
  ): Promise<T> {
    const url = `${HUBSPOT_API_BASE}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method: init.method,
      headers,
      body: init.body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `HubSpot API error: ${response.status} ${response.statusText} - ${text}`,
      );
    }

    return (await response.json()) as T;
  }
}
