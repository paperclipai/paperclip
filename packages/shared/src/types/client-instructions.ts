export interface ClientInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
}

export interface ClientInstructionsFileDetail extends ClientInstructionsFileSummary {
  content: string;
}

export interface ClientInstructionsBundle {
  clientId: string;
  companyId: string;
  rootPath: string;
  entryFile: string;
  files: ClientInstructionsFileSummary[];
}
