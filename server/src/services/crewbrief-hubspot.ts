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

  async function upsertContactProperty(
    propertyName: string,
    label: string,
    type: "string" | "number" | "date" | "datetime" | "enumeration",
    fieldType: "single_line_text" | "number" | "date" | "checkbox" | "select" = "single_line_text",
    options?: Array<{ label: string; value: string }>,
  ): Promise<{ error: string | null }> {
    const body: Record<string, unknown> = {
      name: propertyName,
      label,
      type,
      fieldType,
      groupName: "contactinformation",
    };
    if (options) body.options = options;
    const { error } = await apiCall<unknown>("PUT", `/crm/v3/properties/contacts/${propertyName}`, body);
    if (error && error.includes("404")) {
      return apiCall<unknown>("POST", "/crm/v3/properties/contacts", body);
    }
    return { error };
  }

  interface ContactPropertyDef {
    name: string;
    label: string;
    type: "string" | "number" | "date" | "datetime" | "enumeration";
    fieldType: "single_line_text" | "number" | "date" | "checkbox" | "select";
    options?: Array<{ label: string; value: string }>;
  }

  async function ensureContactProperties(): Promise<{ error: string | null }> {
    const properties: ContactPropertyDef[] = [
      { name: "last_active_date", label: "Last Active Date", type: "date", fieldType: "date" },
      { name: "trial_start_date", label: "Trial Start Date", type: "date", fieldType: "date" },
      { name: "briefing_count", label: "Briefing Count", type: "number", fieldType: "number" },
      { name: "routes_count", label: "Routes Count", type: "number", fieldType: "number" },
      { name: "frats_completed", label: "FRATs Completed", type: "number", fieldType: "number" },
      { name: "time_saved", label: "Time Saved (minutes)", type: "number", fieldType: "number" },
      { name: "sequence_1_status", label: "Seq 1: Beta Welcome Status", type: "enumeration", fieldType: "select", options: [
        { label: "Not enrolled", value: "not_enrolled" },
        { label: "Enrolled", value: "enrolled" },
        { label: "Completed", value: "completed" },
        { label: "Unenrolled", value: "unenrolled" },
      ]},
      { name: "sequence_2_status", label: "Seq 2: Re-engagement Status", type: "enumeration", fieldType: "select", options: [
        { label: "Not enrolled", value: "not_enrolled" },
        { label: "Enrolled", value: "enrolled" },
        { label: "Completed", value: "completed" },
        { label: "Unenrolled", value: "unenrolled" },
      ]},
      { name: "sequence_3_status", label: "Seq 3: Trial-to-Paid Status", type: "enumeration", fieldType: "select", options: [
        { label: "Not enrolled", value: "not_enrolled" },
        { label: "Enrolled", value: "enrolled" },
        { label: "Completed", value: "completed" },
        { label: "Unenrolled", value: "unenrolled" },
      ]},
      { name: "lifecyclestage", label: "Lifecycle Stage", type: "enumeration", fieldType: "select", options: [
        { label: "Lead", value: "lead" },
        { label: "Opportunity", value: "opportunity" },
        { label: "Customer", value: "customer" },
        { label: "Evangelist", value: "evangelist" },
      ]},
    ];
    for (const prop of properties) {
      const { error } = await upsertContactProperty(prop.name, prop.label, prop.type, prop.fieldType, prop.options);
      if (error) return { error };
    }
    return { error: null };
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
    upsertContactProperty,
    ensureContactProperties,
  };
}

export type CrewbriefHubspotService = ReturnType<typeof crewbriefHubspotService>;
