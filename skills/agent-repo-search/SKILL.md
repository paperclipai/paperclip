---
name: agent-repo-search
description: Skill for efficiently searching and ingesting large codebases using a pre-generated structural index and CXML chunks. Use this skill when you need to understand or work with a repository that exceeds context limits, or when you want to minimize token usage by fetching only relevant code sections.
roles: [cto, developer]
---

# Agent Repository Search & Ingest Skill

This skill enables an inference agent to interact with a repository that has been processed by the internal `rendergit` tool. 

## Preparation: Ingesting a Repository
If the user provides a repository URL that has not yet been ingested, or if you need fresh context, you MUST first run the ingestion tool located within this plugin:

```bash
uv run --project $(dirname $(dirname $(dirname $SKILL_PATH))) python $(dirname $(dirname $(dirname $SKILL_PATH)))/rendergit.py <REPO_URL> -o <OUTPUT_DIR>
```

(Note: `$SKILL_PATH` is the environment variable pointing to this markdown file). Use a consistent `<OUTPUT_DIR>` (e.g., `repo_context/`) to store the resulting `index.txt` and `.cxml` chunks.

## Standard Workflow

You MUST follow this three-step process for every repository interaction:

### Step 1: Structural Scan & Strategic Probing (Bootstrapping Reality)
Always start by reading the `index.txt` file at the root of the output directory.
- **Analyze the Structure:** Identify the primary directories and entry points (e.g., `src/`, `crates/`, `README.md`, `main.rs`).
- **Strategic Probing:** If the `index.txt` only contains structural tags (e.g., `[Directory]`), you MUST perform a high-signal probe. Read the first 100-200 lines of the repository's `README.md` and the core `lib.rs`, `main.py`, or `index.ts` files to understand the project's true purpose.
- **MANDATORY HUMAN OUTPUT:** Provide a "Grounded Repository Landscape" summary.
    - **Physical Reality:** Describe the repository solely in terms of the **implemented crates/modules** you have verified.
    - **Skeletal Flags:** If a directory exists but seems to be boilerplate or empty in the index, flag it immediately.
    - **Targeted Chunks:** State which `.cxml` chunks you are about to ingest to solve the user's specific query.

### Step 2: Fetch & Implementation Audit
Once you have shared the landscape, fetch the specific `.cxml` chunk(s).
- **Verify Logic:** Do not rely on documentation. Look for actual function bodies, class structures, and imports.
- **Implementation Gaps:** If you find a feature described in comments/README (intent) that is missing from the code (reality), report this discrepancy in a dedicated "Implementation Gaps" section.

### Step 3: Synthesis & Answer
When providing the final answer, follow this structure:

1. **Grounded Landscape:** A 3-5 line summary of the **implemented** repository structure (ignore marketing claims).
2. **Analysis:** Findings from the code chunks, focusing on verified logic.
3. **Implementation Gaps:** A clear list of features described in documentation but missing or skeletal in the code.
4. **Evidence:** Direct references to file paths and logic found in the `.cxml` chunks.

## Error Handling & Iteration

- **Missing Logic:** If a retrieved chunk does not contain the specific function or logic you expected based on the index description, do not give up. Go back to `index.txt`, re-evaluate your assumptions, and fetch the next most likely chunk.
- **Cross-Domain Dependencies:** If you find a function call or class inheritance that points to another part of the repository, use the index to find the chunk containing that dependency and fetch it.
- **Chunk Limits:** If a task requires logic spread across many chunks, fetch them one at a time to stay within your context window. Summarize what you learn from each chunk before fetching the next if necessary.

## Best Practices

- **Token Efficiency:** Your goal is to solve the task with the minimum number of tokens. Avoid fetching chunks that the index suggests are irrelevant (e.g., documentation-only folders, unrelated services).
- **Concise Summaries:** When reporting findings to the user, focus on the logic found in the fetched chunks rather than the index itself.
