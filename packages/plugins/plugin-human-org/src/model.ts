export type HumanProfileStatus = "active" | "inactive";

export interface HumanOrgChartRow {
  externalId: string;
  name: string;
  email?: string | null;
  title?: string | null;
  reportsToExternalId?: string | null;
  capabilities?: string[];
  responsibilities?: string[];
  mattermostUsername?: string | null;
  paperclipUserId?: string | null;
  status?: HumanProfileStatus;
}

export interface HumanProfile {
  externalId: string;
  name: string;
  email: string | null;
  title: string | null;
  reportsToExternalId: string | null;
  capabilities: string[];
  responsibilities: string[];
  mattermostUsername: string | null;
  paperclipUserId: string | null;
  status: HumanProfileStatus;
}

export interface OrgChartValidationError {
  code:
    | "missing_external_id"
    | "missing_name"
    | "duplicate_external_id"
    | "unknown_manager"
    | "self_manager"
    | "reporting_cycle"
    | "invalid_email"
    | "invalid_mattermost_username"
    | "invalid_status"
    | "input_limit";
  row?: number;
  externalId?: string;
  message: string;
}

export const HUMAN_ORG_LIMITS = {
  importCharacters: 2_000_000,
  rows: 5_000,
  externalId: 128,
  name: 200,
  email: 320,
  title: 200,
  paperclipUserId: 128,
  listItems: 100,
  listItem: 200,
  taskTitle: 500,
  taskDescription: 50_000,
} as const;

export interface OrgTreeNode {
  profile: HumanProfile;
  children: OrgTreeNode[];
}

const HEADER_ALIASES: Record<string, keyof HumanOrgChartRow> = {
  external_id: "externalId",
  externalid: "externalId",
  id: "externalId",
  name: "name",
  email: "email",
  title: "title",
  role: "title",
  reports_to_external_id: "reportsToExternalId",
  reportstoexternalid: "reportsToExternalId",
  manager_id: "reportsToExternalId",
  manager: "reportsToExternalId",
  capabilities: "capabilities",
  skills: "capabilities",
  responsibilities: "responsibilities",
  mattermost_username: "mattermostUsername",
  mattermostusername: "mattermostUsername",
  paperclip_user_id: "paperclipUserId",
  paperclipuserid: "paperclipUserId",
  status: "status",
};

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map(cleanString).filter((item): item is string => item !== null))];
  }
  const text = cleanString(value);
  if (!text) return [];
  return [...new Set(text.split("|").map((item) => item.trim()).filter(Boolean))];
}

function normalizeStatus(value: unknown, strict: boolean): HumanProfileStatus {
  const normalized = cleanString(value)?.toLowerCase();
  if (!normalized || normalized === "active") return "active";
  if (normalized === "inactive") return "inactive";
  if (strict) throw new Error("status must be active or inactive");
  return "active";
}

const RESERVED_MATTERMOST_MENTIONS = new Set(["all", "channel", "everyone", "here"]);

function neutralizeMattermostBroadcastMentions(value: string): string {
  return value.replace(/@(channel|all|here|everyone)\b/gi, "@\u200B$1");
}

function escapeMattermostMarkdown(value: string): string {
  const markdownCharacters = new Set(["\\", "[", "]", "(", ")", "*", "_", "~", "`", ">"]);
  return Array.from(neutralizeMattermostBroadcastMentions(value), (character) => (
    markdownCharacters.has(character) ? `\\${character}` : character
  )).join("");
}

function safeMattermostLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

function parseCsvMatrix(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (afterQuote) {
      if (char === ",") {
        row.push(field);
        field = "";
        afterQuote = false;
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        afterQuote = false;
      } else if (char !== "\r") {
        throw new Error("Malformed CSV quote: unexpected characters after a closing quote");
      }
      continue;
    }

    if (char === '"') {
      if (field.length > 0) throw new Error("Malformed CSV quote inside an unquoted field");
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

function normalizeOrgChartRowInternal(input: Record<string, unknown>, strictStatus: boolean): HumanProfile {
  return {
    externalId: cleanString(input.externalId) ?? "",
    name: cleanString(input.name) ?? "",
    email: cleanString(input.email),
    title: cleanString(input.title),
    reportsToExternalId: cleanString(input.reportsToExternalId),
    capabilities: stringList(input.capabilities),
    responsibilities: stringList(input.responsibilities),
    mattermostUsername: cleanString(input.mattermostUsername)?.replace(/^@/, "") ?? null,
    paperclipUserId: cleanString(input.paperclipUserId),
    status: normalizeStatus(input.status, strictStatus),
  };
}

export function normalizeOrgChartRow(input: Record<string, unknown>): HumanProfile {
  return normalizeOrgChartRowInternal(input, true);
}

export function normalizeOrgChartRows(input: unknown): HumanProfile[] {
  if (!Array.isArray(input)) throw new Error("Org chart JSON must be an array of people");
  if (input.length > HUMAN_ORG_LIMITS.rows) {
    throw new Error(`Org chart imports are limited to ${HUMAN_ORG_LIMITS.rows.toLocaleString("en-US")} people`);
  }
  return input.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return normalizeOrgChartRow({});
    }
    const source = row as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      const alias = HEADER_ALIASES[key.trim().toLowerCase().replace(/[ -]/g, "_")] ?? key;
      mapped[alias] = value;
    }
    return normalizeOrgChartRow(mapped);
  });
}

export function parseOrgChartCsv(input: string): HumanProfile[] {
  if (input.length > HUMAN_ORG_LIMITS.importCharacters) {
    throw new Error(`Org chart imports are limited to ${HUMAN_ORG_LIMITS.importCharacters.toLocaleString("en-US")} characters`);
  }
  const matrix = parseCsvMatrix(input.replace(/^\uFEFF/, ""));
  if (matrix.length < 2) throw new Error("CSV must include a header and at least one person");
  if (matrix.length - 1 > HUMAN_ORG_LIMITS.rows) {
    throw new Error(`Org chart imports are limited to ${HUMAN_ORG_LIMITS.rows.toLocaleString("en-US")} people`);
  }
  const rawHeaders = matrix[0]!;
  const headers = rawHeaders.map((header) => {
    const normalized = header.trim().toLowerCase().replace(/[ -]/g, "_");
    return HEADER_ALIASES[normalized] ?? null;
  });
  const unknownHeaders = rawHeaders.filter((_header, index) => headers[index] === null);
  if (unknownHeaders.length > 0) {
    throw new Error(`Unknown CSV header: ${unknownHeaders.join(", ")}`);
  }
  const seenHeaders = new Set<keyof HumanOrgChartRow>();
  for (const header of headers) {
    if (!header) continue;
    if (seenHeaders.has(header)) throw new Error(`Duplicate CSV header: ${header}`);
    seenHeaders.add(header);
  }
  if (!headers.includes("externalId") || !headers.includes("name")) {
    throw new Error("CSV requires external_id and name columns");
  }

  return matrix.slice(1).map((cells, rowIndex) => {
    if (cells.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${cells.length} cells; expected ${headers.length}`);
    }
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      if (header) row[header] = cells[index] ?? "";
    });
    return normalizeOrgChartRow(row);
  });
}

export function validateOrgChartRows(rows: HumanOrgChartRow[]): OrgChartValidationError[] {
  if (rows.length > HUMAN_ORG_LIMITS.rows) {
    return [{
      code: "input_limit",
      message: `Org chart imports are limited to ${HUMAN_ORG_LIMITS.rows.toLocaleString("en-US")} people`,
    }];
  }
  const normalized = rows.map((row) => normalizeOrgChartRowInternal(row as unknown as Record<string, unknown>, false));
  const errors: OrgChartValidationError[] = [];
  const counts = new Map<string, number>();

  normalized.forEach((row, index) => {
    const scalarLimits: Array<[string, string | null, number]> = [
      ["external_id", row.externalId, HUMAN_ORG_LIMITS.externalId],
      ["name", row.name, HUMAN_ORG_LIMITS.name],
      ["email", row.email, HUMAN_ORG_LIMITS.email],
      ["title", row.title, HUMAN_ORG_LIMITS.title],
      ["reports_to_external_id", row.reportsToExternalId, HUMAN_ORG_LIMITS.externalId],
      ["paperclip_user_id", row.paperclipUserId, HUMAN_ORG_LIMITS.paperclipUserId],
    ];
    for (const [field, value, maximum] of scalarLimits) {
      if (value && value.length > maximum) {
        errors.push({
          code: "input_limit",
          row: index + 2,
          externalId: row.externalId || undefined,
          message: `${field} for ${row.externalId || `row ${index + 2}`} exceeds ${maximum} characters`,
        });
      }
    }
    for (const [field, values] of [
      ["capabilities", row.capabilities],
      ["responsibilities", row.responsibilities],
    ] as const) {
      if (values.length > HUMAN_ORG_LIMITS.listItems) {
        errors.push({
          code: "input_limit",
          row: index + 2,
          externalId: row.externalId || undefined,
          message: `${field} for ${row.externalId || `row ${index + 2}`} exceeds ${HUMAN_ORG_LIMITS.listItems} items`,
        });
      }
      if (values.some((value) => value.length > HUMAN_ORG_LIMITS.listItem)) {
        errors.push({
          code: "input_limit",
          row: index + 2,
          externalId: row.externalId || undefined,
          message: `${field} for ${row.externalId || `row ${index + 2}`} contains an item exceeding ${HUMAN_ORG_LIMITS.listItem} characters`,
        });
      }
    }
    if (!row.externalId) {
      errors.push({ code: "missing_external_id", row: index + 2, message: `Row ${index + 2} is missing external_id` });
    } else {
      counts.set(row.externalId, (counts.get(row.externalId) ?? 0) + 1);
    }
    if (!row.name) {
      errors.push({ code: "missing_name", row: index + 2, externalId: row.externalId || undefined, message: `Row ${index + 2} is missing name` });
    }
    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
      errors.push({ code: "invalid_email", row: index + 2, externalId: row.externalId, message: `Invalid email for ${row.externalId || `row ${index + 2}`}` });
    }
    if (row.mattermostUsername && (
      !/^[A-Za-z0-9._-]{1,64}$/.test(row.mattermostUsername)
      || RESERVED_MATTERMOST_MENTIONS.has(row.mattermostUsername.toLowerCase())
    )) {
      errors.push({
        code: "invalid_mattermost_username",
        row: index + 2,
        externalId: row.externalId,
        message: `Invalid Mattermost username for ${row.externalId || `row ${index + 2}`}`,
      });
    }
    const rawStatus = cleanString((rows[index] as HumanOrgChartRow | undefined)?.status)?.toLowerCase();
    if (rawStatus && rawStatus !== "active" && rawStatus !== "inactive") {
      errors.push({ code: "invalid_status", row: index + 2, externalId: row.externalId, message: `Status for ${row.externalId} must be active or inactive` });
    }
  });

  for (const [externalId, count] of counts) {
    if (count > 1) {
      errors.push({ code: "duplicate_external_id", externalId, message: `Duplicate external_id: ${externalId}` });
    }
  }

  const ids = new Set(normalized.map((row) => row.externalId).filter(Boolean));
  for (const row of normalized) {
    if (!row.externalId || !row.reportsToExternalId) continue;
    if (row.reportsToExternalId === row.externalId) {
      errors.push({ code: "self_manager", externalId: row.externalId, message: `${row.externalId} cannot report to itself` });
    } else if (!ids.has(row.reportsToExternalId)) {
      errors.push({ code: "unknown_manager", externalId: row.externalId, message: `Unknown manager ${row.reportsToExternalId} for ${row.externalId}` });
    }
  }

  const managerById = new Map(normalized.map((row) => [row.externalId, row.reportsToExternalId]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cycleMembers = new Set<string>();
  function visit(id: string, path: string[]): void {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      for (const member of path.slice(start)) cycleMembers.add(member);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const manager = managerById.get(id);
    if (manager && managerById.has(manager)) visit(manager, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id, []);
  if (cycleMembers.size > 0) {
    const members = [...cycleMembers].sort();
    errors.push({ code: "reporting_cycle", externalId: members[0], message: `Reporting cycle detected: ${members.join(" → ")}` });
  }
  return errors;
}

export function buildOrgTree(profiles: HumanProfile[]): OrgTreeNode[] {
  const active = profiles.filter((profile) => profile.status === "active");
  const nodes = new Map(active.map((profile) => [profile.externalId, { profile, children: [] as OrgTreeNode[] }]));
  const roots: OrgTreeNode[] = [];
  for (const node of nodes.values()) {
    const manager = node.profile.reportsToExternalId ? nodes.get(node.profile.reportsToExternalId) : null;
    if (manager) manager.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: OrgTreeNode[]) => {
    items.sort((left, right) => left.profile.name.localeCompare(right.profile.name));
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

export function buildMattermostAssignmentPayload(input: {
  humanName: string;
  mattermostUsername?: string | null;
  issueTitle: string;
  issueIdentifier: string;
  issueUrl: string;
  priority?: string | null;
}): { text: string; props: { card: string } } {
  const mention = input.mattermostUsername ? `@${input.mattermostUsername.replace(/^@/, "")}` : input.humanName;
  const priority = input.priority ? ` · priority **${input.priority}**` : "";
  const safeHumanName = escapeMattermostMarkdown(input.humanName);
  const safeMention = input.mattermostUsername ? mention : safeHumanName;
  const safeIssueTitle = escapeMattermostMarkdown(input.issueTitle);
  const label = `${escapeMattermostMarkdown(input.issueIdentifier)}: ${safeIssueTitle}`;
  const url = safeMattermostLink(input.issueUrl);
  const task = url ? `[${label}](${url})` : label;
  const line = `${safeMention} — Paperclip assigned ${task}${priority}.`;
  return {
    text: line,
    props: {
      card: `### New Paperclip task\n${line}\n\nOpen the task in Paperclip to update status, add notes, or request help.`,
    },
  };
}

export const SAMPLE_ORG_CHART_CSV = `external_id,name,email,title,reports_to_external_id,capabilities,responsibilities,mattermost_username,paperclip_user_id,status
exec-1,Asha Patel,asha@example.com,CEO,,strategy|budget,Set direction|Approve budget,asha,,active
eng-1,Diego Ruiz,diego@example.com,Engineer,exec-1,typescript|aws,Build services|Review code,diego,,active
ops-1,Maya Chen,maya@example.com,Revenue Cycle Lead,exec-1,rcm|payer-operations,Own payer operations|Escalate denials,maya,,active
`;
