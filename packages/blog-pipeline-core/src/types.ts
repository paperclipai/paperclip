export type BlogPipelineRunContext = {
  run_id?: string;
  topic?: string;
  lane?: string;
  category_family?: string;
  target_site?: string;
  wordpress?: {
    publish?: boolean;
    status?: string;
    post_id?: number | null;
  };
  image?: Record<string, unknown>;
  [key: string]: unknown;
};

export type BlogPipelineStepInput = {
  runDir: string;
  context?: BlogPipelineRunContext;
  [key: string]: unknown;
};

export type BlogPipelineStepResult = Record<string, unknown> | null;
