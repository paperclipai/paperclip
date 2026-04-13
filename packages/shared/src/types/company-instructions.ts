export interface CompanyInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
}

export interface CompanyInstructionsFileDetail extends CompanyInstructionsFileSummary {
  content: string;
}

export interface CompanyInstructionsBundle {
  companyId: string;
  rootPath: string;
  entryFile: string;
  files: CompanyInstructionsFileSummary[];
}
