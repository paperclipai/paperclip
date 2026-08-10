import type { Agent } from "@paperclipai/shared";

// ── The 2.5D "office": departments become rooms, agents become desks ─────
// Pure layout math (no React) so it can be unit-tested. An isometric (2:1)
// grid turns cell coordinates into screen points; rooms are packed row-major
// and every coordinate is shifted positive with a screen-space padding.

export type OfficeView = "lite" | "deep";

export const DEPARTMENTS = [
  "Executive",
  "Engineering",
  "Product",
  "Design",
  "Quality",
  "Security",
  "Research",
  "General",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

// Real Paperclip agent roles → department (rooms). Unknown roles fall back to
// "General" so a new role never disappears from the office.
const ROLE_DEPARTMENT: Record<string, Department> = {
  ceo: "Executive",
  cfo: "Executive",
  cmo: "Executive",
  cto: "Engineering",
  engineer: "Engineering",
  devops: "Engineering",
  pm: "Product",
  designer: "Design",
  qa: "Quality",
  security: "Security",
  researcher: "Research",
  general: "General",
};

export function departmentForRole(role: string): Department {
  return ROLE_DEPARTMENT[role] ?? "General";
}

// Isometric projection + packing constants.
const TILE_W = 96; // iso tile width (screen px per cell on the x axis)
const TILE_H = 48; // iso tile height (2:1)
const DESK_STEP = 2; // cells between adjacent desks (keeps avatars from overlapping)
const ROOM_BORDER = 1; // cell margin between a room's wall and its desks
const ROOM_GAP = 2; // cells between rooms
const PADDING = 100; // screen px around the whole office

interface Cell {
  gx: number;
  gy: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

function project(gx: number, gy: number): ScreenPoint {
  return { x: (gx - gy) * (TILE_W / 2), y: (gx + gy) * (TILE_H / 2) };
}

// ── Curated ("Lite") roster ──────────────────────────────────────────────
// Roots (top of the org) plus one representative per present department,
// chosen by shallowest org depth, then "more live" status, then name.

const STATUS_RANK: Record<string, number> = { running: 0, active: 1 };
function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 2;
}

function agentDepth(agent: Agent, byId: Map<string, Agent>): number {
  let depth = 0;
  let current: Agent | undefined = agent;
  const seen = new Set<string>();
  while (current && current.reportsTo && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.reportsTo);
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}

export function visibleAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.status !== "terminated");
}

export function curatedSubset(agents: Agent[]): Agent[] {
  const active = visibleAgents(agents);
  const byId = new Map(active.map((a) => [a.id, a]));
  const chosen = new Map<string, Agent>();

  // Roots first (usually the CEO / owner / orchestrator).
  for (const a of active) {
    if (a.reportsTo == null) chosen.set(a.id, a);
  }

  // One representative per department that has any members.
  const byDept = new Map<Department, Agent[]>();
  for (const a of active) {
    const dept = departmentForRole(a.role);
    const list = byDept.get(dept);
    if (list) list.push(a);
    else byDept.set(dept, [a]);
  }
  for (const members of byDept.values()) {
    const rep = members
      .slice()
      .sort((x, y) => {
        const dx = agentDepth(x, byId);
        const dy = agentDepth(y, byId);
        if (dx !== dy) return dx - dy;
        const sx = statusRank(x.status);
        const sy = statusRank(y.status);
        if (sx !== sy) return sx - sy;
        return x.name.localeCompare(y.name);
      })[0];
    if (rep) chosen.set(rep.id, rep);
  }

  return [...chosen.values()];
}

export function rosterForView(agents: Agent[], view: OfficeView): Agent[] {
  return view === "lite" ? curatedSubset(agents) : visibleAgents(agents);
}

// ── Room packing (cell space) ────────────────────────────────────────────

export interface RoomCellRect {
  department: Department;
  count: number;
  ox: number;
  oy: number;
  w: number;
  h: number;
}

function deskGrid(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, rows };
}

function roomFootprint(n: number): { w: number; h: number; cols: number; rows: number } {
  const { cols, rows } = deskGrid(n);
  const interiorW = (cols - 1) * DESK_STEP + 1;
  const interiorH = (rows - 1) * DESK_STEP + 1;
  return { w: interiorW + 2 * ROOM_BORDER, h: interiorH + 2 * ROOM_BORDER, cols, rows };
}

/**
 * Pack the given departments (each with a member count) into a row-major grid
 * of `roomsPerRow` columns, returning each room's rectangle in CELL space.
 * Exported for unit testing (non-overlap).
 */
export function packRooms(
  counts: Array<{ department: Department; count: number }>,
  roomsPerRow: number,
): RoomCellRect[] {
  const perRow = Math.max(1, roomsPerRow);
  const rects: RoomCellRect[] = [];
  let rowStartGY = 0;
  for (let i = 0; i < counts.length; i += perRow) {
    const row = counts.slice(i, i + perRow);
    let cursorGX = 0;
    let rowMaxH = 0;
    for (const { department, count } of row) {
      const fp = roomFootprint(count);
      rects.push({ department, count, ox: cursorGX, oy: rowStartGY, w: fp.w, h: fp.h });
      cursorGX += fp.w + ROOM_GAP;
      rowMaxH = Math.max(rowMaxH, fp.h);
    }
    rowStartGY += rowMaxH + ROOM_GAP;
  }
  return rects;
}

function deskCells(rect: RoomCellRect, n: number): Cell[] {
  const { cols } = deskGrid(n);
  const cells: Cell[] = [];
  for (let index = 0; index < n; index++) {
    const c = index % cols;
    const r = Math.floor(index / cols);
    cells.push({
      gx: rect.ox + ROOM_BORDER + c * DESK_STEP,
      gy: rect.oy + ROOM_BORDER + r * DESK_STEP,
    });
  }
  return cells;
}

// ── Full layout (screen space) ───────────────────────────────────────────

export interface OfficeDesk {
  agent: Agent;
  x: number;
  y: number;
}

export interface OfficeRoom {
  department: Department;
  label: string;
  count: number;
  /** Diamond floor corners in screen space: north, east, south, west. */
  polygon: ScreenPoint[];
  /** Top ("north") corner, where the room label sits. */
  labelAnchor: ScreenPoint;
}

export interface OfficeLayout {
  rooms: OfficeRoom[];
  desks: OfficeDesk[];
  bounds: { width: number; height: number };
}

export function layoutOffice(agents: Agent[], roomsPerRow: number): OfficeLayout {
  if (agents.length === 0) {
    return { rooms: [], desks: [], bounds: { width: 800, height: 600 } };
  }

  // Group by department, preserving DEPARTMENTS order, dropping empties.
  const byDept = new Map<Department, Agent[]>();
  for (const a of agents) {
    const dept = departmentForRole(a.role);
    const list = byDept.get(dept);
    if (list) list.push(a);
    else byDept.set(dept, [a]);
  }
  const ordered = DEPARTMENTS.filter((d) => byDept.has(d)).map((d) => ({
    department: d,
    members: byDept.get(d)!,
  }));

  const rects = packRooms(
    ordered.map((o) => ({ department: o.department, count: o.members.length })),
    roomsPerRow,
  );

  // Project everything to raw iso screen coords, tracking bounds.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const track = (p: ScreenPoint) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };

  interface RawRoom {
    department: Department;
    count: number;
    polygon: ScreenPoint[];
    labelAnchor: ScreenPoint;
  }
  const rawRooms: RawRoom[] = [];
  const rawDesks: Array<{ agent: Agent; point: ScreenPoint }> = [];

  rects.forEach((rect, roomIndex) => {
    const north = project(rect.ox, rect.oy);
    const east = project(rect.ox + rect.w, rect.oy);
    const south = project(rect.ox + rect.w, rect.oy + rect.h);
    const west = project(rect.ox, rect.oy + rect.h);
    const polygon = [north, east, south, west];
    polygon.forEach(track);
    // Label above the north corner.
    const labelAnchor = { x: north.x, y: north.y - 14 };
    track(labelAnchor);
    rawRooms.push({ department: rect.department, count: rect.count, polygon, labelAnchor });

    const members = ordered[roomIndex]!.members;
    const cells = deskCells(rect, members.length);
    cells.forEach((cell, i) => {
      // Center of the desk cell.
      const point = project(cell.gx + 0.5, cell.gy + 0.5);
      track(point);
      rawDesks.push({ agent: members[i]!, point });
    });
  });

  const offsetX = PADDING - minX;
  const offsetY = PADDING - minY;
  const shift = (p: ScreenPoint): ScreenPoint => ({ x: p.x + offsetX, y: p.y + offsetY });

  const rooms: OfficeRoom[] = rawRooms.map((r) => ({
    department: r.department,
    label: r.department,
    count: r.count,
    polygon: r.polygon.map(shift),
    labelAnchor: shift(r.labelAnchor),
  }));
  const desks: OfficeDesk[] = rawDesks.map((d) => ({
    agent: d.agent,
    x: d.point.x + offsetX,
    y: d.point.y + offsetY,
  }));

  const bounds = {
    width: maxX - minX + 2 * PADDING,
    height: maxY - minY + 2 * PADDING,
  };

  return { rooms, desks, bounds };
}
