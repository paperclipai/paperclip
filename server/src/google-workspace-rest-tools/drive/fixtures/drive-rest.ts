import type { RestFile } from "../file.js";

export const DOC: RestFile = {
  id: "doc0001synthetic",
  name: "Quarterly plan",
  mimeType: "application/vnd.google-apps.document",
  parents: ["folder0001synthetic"],
  description: "Synthetic test document",
  webViewLink: "https://docs.example.test/document/d/doc0001synthetic/edit",
  createdTime: "2026-10-01T09:00:00.000Z",
  modifiedTime: "2026-11-02T10:30:00.000Z",
  viewedByMeTime: "2026-11-03T08:00:00.000Z",
  owners: [{ emailAddress: "owner@example.test", displayName: "Owner Example" }],
  lastModifyingUser: { emailAddress: "editor@example.test", displayName: "Editor Example" },
  capabilities: { canAddChildren: false },
};

export const SHEET: RestFile = { id: "sheet0001synthetic", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" };
export const SLIDES: RestFile = { id: "slides0001synthetic", name: "Deck", mimeType: "application/vnd.google-apps.presentation" };
export const DRAWING: RestFile = { id: "draw0001synthetic", name: "Sketch", mimeType: "application/vnd.google-apps.drawing" };
export const FORM: RestFile = { id: "form0001synthetic", name: "Survey", mimeType: "application/vnd.google-apps.form" };

export const FOLDER: RestFile = {
  id: "folder0001synthetic",
  name: "Projects",
  mimeType: "application/vnd.google-apps.folder",
  capabilities: { canAddChildren: true },
};

export const TEXT_FILE: RestFile = { id: "text0001synthetic", name: "notes.txt", mimeType: "text/plain", size: "12", fileExtension: "txt" };
export const JSON_FILE: RestFile = { id: "json0001synthetic", name: "data.json", mimeType: "application/json", size: "9" };
export const PDF: RestFile = { id: "pdf0001synthetic", name: "report.pdf", mimeType: "application/pdf", size: "2048", fileExtension: "pdf" };
export const HUGE_PDF: RestFile = { ...PDF, id: "pdf0002synthetic", size: String(10 * 1024 * 1024 + 1) };
