/** Public, read-only fixture verified through GitHub's commit and content APIs. */
export const repositoryContinuationSource = {
  url: "https://github.com/octocat/Hello-World",
  commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
  readme: "Hello World!\n",
} as const;

export function repositoryContinuationStory(campaignId: string) {
  if (!/^journey-[0-9]+-[a-f0-9]{8}$/.test(campaignId)) throw new Error("invalid_repository_journey_campaign");
  const suffix = campaignId.replaceAll("-", "");
  const files = { context: `qa-context-${suffix}.txt`, first: `qa-first-${suffix}.txt`,
    followup: `qa-followup-${suffix}.txt`, firstBundle: `qa-first-${suffix}.bundle`, finalBundle: `qa-final-${suffix}.bundle` };
  return {
    files,
    first: [
      "Use this task's configured project repository. Work only in its existing checkout; do not create another repository, project, or task. Do not push anything to a remote.",
      `Verify that its starting HEAD is ${repositoryContinuationSource.commit}, then read the committed README. Stop and report a mismatch if this is not the configured repository.`,
      `Generate a fresh unpredictable 32-byte hexadecimal reference from the operating system random source and save it followed by one LF in ${files.context}. Do not print the reference in comments or your final answer.`,
      `Create ${files.first} containing only the text first followed by exactly one LF newline. Make one local Git commit containing only these two new files. Preserve every original repository file.`,
      `After the commit, create a self-contained Git bundle of HEAD at ${files.firstBundle}. Do not add the bundle to Git.`,
      `Register both ${files.context} and ${files.firstBundle} as downloadable artifacts with those exact filenames and titles. Deliver their accessible links and finish the task. I will send a later follow-up.`,
    ].join("\n"),
    followup: [
      "Continue in the same project checkout. Keep the earlier commit and original files.",
      `Read ${files.context} and ${files.first} from the current workspace. If either is missing or invalid, stop and report the failure. Never recreate either file or recover it from conversation, attachments, or another checkout.`,
      `Keep their original bytes. Add ${files.followup} containing only the text verified followed by exactly one LF newline. Make one more local Git commit containing only that new file. Do not amend or rewrite the earlier commit, and do not push.`,
      `Create a new self-contained Git bundle of HEAD at ${files.finalBundle}. Register it as a downloadable artifact with that exact filename and title. Deliver its accessible link and finish the task.`,
    ].join("\n"),
  };
}
