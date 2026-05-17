const HUBSPOT_API_BASE = "https://api.hubapi.com";

interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

export function crewbriefHubspotService(accessToken?: string) {
  const enabled = !!accessToken;

  async function apiCall<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T | null; error: string | null }> {
    if (!enabled) {
      return { data: null, error: "HubSpot not configured" };
    }
    try {
      const res = await fetch(`${HUBSPOT_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        return { data: null, error: `HubSpot API error ${res.status}: ${text}` };
      }
      const json = await res.json();
      return { data: json as T, error: null };
    } catch (err) {
      return { data: null, error: `HubSpot request failed: ${(err as Error).message}` };
    }
  }

  async function createContact(email: string, properties: Record<string, string>): Promise<{
    contactId: string | null;
    error: string | null;
  }> {
    const { data, error } = await apiCall<{ id: string }>("POST", "/crm/v3/objects/contacts", {
      properties: { email, ...properties },
    });
    if (error) return { contactId: null, error };
    return { contactId: data!.id, error: null };
  }

  async function getContactByEmail(email: string): Promise<{
    contact: HubSpotContact | null;
    error: string | null;
  }> {
    const { data, error } = await apiCall<{ results: HubSpotContact[] }>(
      "POST",
      "/crm/v3/objects/contacts/search",
      {
        filterGroups: [
          {
            filters: [{ propertyName: "email", operator: "EQ", value: email }],
          },
        ],
        limit: 1,
      },
    );
    if (error) return { contact: null, error };
    const contact = data?.results?.[0] ?? null;
    return { contact, error: null };
  }

  async function updateContact(
    contactId: string,
    properties: Record<string, string>,
  ): Promise<{ error: string | null }> {
    const { error } = await apiCall<unknown>("PATCH", `/crm/v3/objects/contacts/${contactId}`, {
      properties,
    });
    return { error };
  }

  async function upsertContact(
    email: string,
    properties: Record<string, string>,
  ): Promise<{ contactId: string | null; error: string | null }> {
    const { contact, error: lookupErr } = await getContactByEmail(email);
    if (lookupErr) return { contactId: null, error: lookupErr };
    if (contact) {
      const { error: updateErr } = await updateContact(contact.id, properties);
      if (updateErr) return { contactId: null, error: updateErr };
      return { contactId: contact.id, error: null };
    }
    return createContact(email, properties);
  }

  async function createDeal(
    dealName: string,
    pipelineStage: string,
    contactId: string,
    properties?: Record<string, string>,
  ): Promise<{ dealId: string | null; error: string | null }> {
    const { data, error } = await apiCall<{ id: string }>("POST", "/crm/v3/objects/deals", {
      properties: {
        dealname: dealName,
        dealstage: pipelineStage,
        hs_object_source: "INTEGRATION",
        ...properties,
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 5,
            },
          ],
        },
      ],
    });
    if (error) return { dealId: null, error };
    return { dealId: data!.id, error: null };
  }

  async function updateDealStage(
    dealId: string,
    stage: string,
  ): Promise<{ error: string | null }> {
    return apiCall<unknown>("PATCH", `/crm/v3/objects/deals/${dealId}`, {
      properties: { dealstage: stage },
    });
  }

  async function logNote(
    contactId: string,
    noteBody: string,
  ): Promise<{ noteId: string | null; error: string | null }> {
    const { data, error } = await apiCall<{ id: string }>("POST", "/crm/v3/objects/notes", {
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: noteBody,
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 202,
            },
          ],
        },
      ],
    });
    if (error) return { noteId: null, error };
    return { noteId: data!.id, error: null };
  }

  async function sendSingleEmail(
    contactId: string,
    fromAddress: string,
    subject: string,
    body: string,
  ): Promise<{ messageId: string | null; error: string | null }> {
    const { data, error } = await apiCall<{ id: string }>(
      "POST",
      "/crm/v3/objects/emails",
      {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_email_direction: "EMAIL",
          hs_email_status: "SENT",
          hs_email_subject: subject,
          hs_email_text: body,
          hs_email_from: fromAddress,
          hs_email_to: contactId,
        },
      },
    );
    if (error) return { messageId: null, error };
    return { messageId: data!.id, error: null };
  }

  return {
    enabled,
    createContact,
    getContactByEmail,
    updateContact,
    upsertContact,
    createDeal,
    updateDealStage,
    logNote,
    sendSingleEmail,
  };
}

export type CrewbriefHubspotService = ReturnType<typeof crewbriefHubspotService>;
