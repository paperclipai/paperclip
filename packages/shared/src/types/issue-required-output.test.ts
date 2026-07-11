import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { suggestTasksPayloadSchema } from "../validators/issue.js";
import type {
  IssueExecutionContractRequiredOutput,
  SuggestTasksPayload,
} from "./issue.js";

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type Assert<Value extends true> = Value;

type MissingDiscriminatorIsRejected = Assert<
  IsAssignable<{ label: string }, IssueExecutionContractRequiredOutput> extends false ? true : false
>;
type UnsupportedDiscriminatorIsRejected = Assert<
  IsAssignable<
    { workProductType: "preview_urll" },
    IssueExecutionContractRequiredOutput
  > extends false ? true : false
>;
type ValidatorOutputMatchesPublicPayload = Assert<
  IsAssignable<z.output<typeof suggestTasksPayloadSchema>, SuggestTasksPayload>
>;

describe("issue execution contract required-output types", () => {
  it("accepts every supported discriminator alias and extra metadata", () => {
    const outputs: IssueExecutionContractRequiredOutput[] = [
      { workProductType: "preview_url" },
      { work_product_type: "runtime_service", legacy: true },
      { type: "document", documentKey: "qa-report" },
      {
        workProductType: "artifact",
        work_product_type: "artifact",
        type: "artifact",
        provider: "local",
      },
    ];

    expect(outputs).toHaveLength(4);
  });

  it("keeps broad validator input while narrowing successful output", () => {
    const invalidInput: z.input<typeof suggestTasksPayloadSchema> = {
      version: 1,
      tasks: [{
        clientKey: "task-1",
        title: "Missing discriminator",
        executionContract: {
          core: {
            requiredOutputs: [{ label: "metadata only" }],
          },
        },
      }],
    };

    expect(suggestTasksPayloadSchema.safeParse(invalidInput).success).toBe(false);

    const parsed: SuggestTasksPayload = suggestTasksPayloadSchema.parse({
      version: 1,
      tasks: [{
        clientKey: "task-2",
        title: "Valid discriminator",
        executionContract: {
          core: {
            requiredOutputs: [{ work_product_type: "document", key: "qa-report" }],
          },
        },
      }],
    });

    expect(parsed.tasks[0]?.executionContract?.core?.requiredOutputs).toEqual([
      { work_product_type: "document", key: "qa-report" },
    ]);
  });
});
