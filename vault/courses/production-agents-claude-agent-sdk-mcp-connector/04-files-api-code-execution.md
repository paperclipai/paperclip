---
course_slug: production-agents-claude-agent-sdk-mcp-connector
chapter_num: 4
chapter_slug: files-api-code-execution
title: "Files API + code execution: the complete agent IO surface"
status: draft-for-review
author: vardaan-koenig
agent_drafted_by: course-author
date: 2026-04-30
duration_min: 45
prerequisites_chapters: [1]
learning_objectives:
  - "Upload a PDF and a dataset to the Files API and reference both in a Messages call"
  - "Use the code execution tool to process an uploaded CSV and download the output chart"
  - "Apply the correct content block type (document, image, container_upload) for each file type"
  - "Explain the billing model: what is free, what is charged as tokens, and what is charged as runtime"
key_concepts:
  [files-api, file-id, content-blocks, code-execution, container-upload, billing-model, zdr-ineligibility]
hands_on_exercise: "Upload a PDF once, run three analytical queries against it in three separate Messages calls, and download an auto-generated summary chart"
sources:
  - https://platform.claude.com/docs/en/build-with-claude/files
  - https://claude.com/blog/agent-capabilities-api
  - https://platform.claude.com/docs/en/managed-agents/overview
---

# Files API + code execution: the complete agent IO surface

The Anthropic Files API is a beta document-storage layer that allows developers to upload a file once — up to 500 MB — receive a persistent `file_id`, and reference that ID across multiple Messages requests without re-transmitting the file content each time, launched alongside the MCP connector and code execution tool in May 2025.

The Files API solves a real problem. Without it, a 20-page PDF costs you full bandwidth and ingestion time on every API call that needs it. With it, you upload once and pay that cost once. But the "upload once, use many times" pitch hides a billing nuance that matters at scale: you still pay full input tokens every time you include a file in a Messages request. The savings are in bandwidth and latency, not token cost [1]. This chapter covers the complete IO surface — Files API for document persistence, code execution for computation, and the intersection of both.

> **Prerequisites**: Chapter 1 (Anthropic API key configured)
>
> **Time**: 45 minutes
>
> **Learning objectives**: By the end of this chapter you can upload files, reference them by `file_id`, select the correct content block type, use the code execution tool to generate artifacts, and download output files.

## Key facts

1. The Files API beta header is `files-api-2025-04-14` — required on every request [1].
2. Maximum file size: 500 MB per file; total workspace storage: 500 GB per organization [1].
3. File storage operations (upload, download, list, retrieve, delete) are **free**; file content is billed as input tokens when referenced in a Messages request [1].
4. Code execution pricing: 50 free hours per day, then $0.05 per hour; announced at the May 2025 agent capabilities launch [2].
5. Files uploaded via the Files API are **not eligible for Zero Data Retention (ZDR)** — they are retained until explicitly deleted [1].
6. The Files API is **not available on Amazon Bedrock or Google Vertex AI** — Anthropic-direct API only [1].
7. You can only **download** files created by skills or the code execution tool — not files you uploaded yourself [1].

## Content block types by file format

The Files API supports different file types that map to different content block types in the Messages API. Getting this wrong is the most common integration mistake:

| File type | MIME type | Content block | Use case |
|---|---|---|---|
| PDF | `application/pdf` | `document` | Document analysis, citations |
| Plain text | `text/plain` | `document` | Logs, markdown, config files |
| JPEG, PNG, GIF, WebP | `image/*` | `image` | Visual analysis, screenshots |
| CSV, datasets, binaries | varies | `container_upload` | Code execution, data analysis |

For file types not in this table (`.docx`, `.xlsx`, `.md`), the recommended approach is conversion: convert to plain text or PDF first, then upload.

## Uploading files

Install the Anthropic SDK (not the Agent SDK):

```python
pip install anthropic
```

Upload a PDF and an image:

```python
from anthropic import Anthropic

client = Anthropic()

# Upload a PDF
with open("quarterly_report.pdf", "rb") as f:
    pdf_file = client.beta.files.upload(
        file=("quarterly_report.pdf", f, "application/pdf"),
    )
print(f"PDF file_id: {pdf_file.id}")
# → file_011CNha8iCJcU1wXNR6q4V8w

# Upload a PNG chart
with open("chart.png", "rb") as f:
    image_file = client.beta.files.upload(
        file=("chart.png", f, "image/png"),
    )
print(f"Image file_id: {image_file.id}")
```

```typescript
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import fs from "fs";

const anthropic = new Anthropic();

// Upload a PDF
const pdfFile = await anthropic.beta.files.upload({
  file: await toFile(
    fs.createReadStream("quarterly_report.pdf"),
    undefined,
    { type: "application/pdf" }
  ),
});
console.log(`PDF file_id: ${pdfFile.id}`);
```

The returned `file_id` is permanent until you delete it. Store it in your database alongside the document metadata.

## Referencing files in Messages calls

Once uploaded, reference the `file_id` using the appropriate content block type. You don't need the file's bytes — just the ID:

```python
# Three queries against the same PDF — only one upload needed
questions = [
    "What were the total revenues in Q1?",
    "List the top 3 risk factors mentioned in this report.",
    "What is management's outlook for Q2?",
]

for question in questions:
    response = client.beta.messages.create(
        model="claude-opus-4-7",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": question},
                {
                    "type": "document",
                    "source": {
                        "type": "file",
                        "file_id": pdf_file.id,
                    },
                    "citations": {"enabled": True},  # request inline citations
                },
            ],
        }],
        betas=["files-api-2025-04-14"],
    )
    print(f"\n{question}")
    print(response.content[0].text)
```

For images, use the `image` content block type:

```python
response = client.beta.messages.create(
    model="claude-opus-4-7",
    max_tokens=512,
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Describe what this chart shows."},
            {
                "type": "image",
                "source": {
                    "type": "file",
                    "file_id": image_file.id,
                },
            },
        ],
    }],
    betas=["files-api-2025-04-14"],
)
```

<Callout type="warn">
Using an image `file_id` in a `document` block (or vice versa) returns a `400 invalid_request_error`. The content block type must match the file's MIME type. If you see this error, check that you're using `"type": "document"` for PDFs and text, and `"type": "image"` for image files.
</Callout>

## The billing reality

The "upload once" pitch is accurate for bandwidth. Here's the complete billing picture:

**Free operations:**
- `POST /v1/files` (upload)
- `GET /v1/files` (list)
- `GET /v1/files/{id}` (metadata)
- `DELETE /v1/files/{id}` (delete)
- `GET /v1/files/{id}/content` (download)

**Billed as input tokens:**
- Every time a `file_id` is included in a Messages request, the file content is counted as input tokens

**Billed as compute time:**
- Code execution: 50 free hours/day, then $0.05/hr

The implications for a document-heavy agent:
- Uploading a 5 MB PDF once: free
- Referencing that PDF in 100 Messages calls: 100× the input token cost of that document
- The upload saves you 100 round trips of bandwidth, but you still pay tokens each time

For agents that run many queries against the same document in a single session, consider using extended prompt caching (1-hour TTL) to reduce the per-call token cost after the first invocation.

## Code execution with the Files API

The code execution tool gives Claude a sandboxed Python environment. You can pass files to it via `container_upload` blocks, run code, and download output files via the Files API:

```python
# Upload a dataset for code execution
with open("sales_data.csv", "rb") as f:
    dataset = client.beta.files.upload(
        file=("sales_data.csv", f, "text/plain"),
    )

# Run code execution with the uploaded file
response = client.beta.messages.create(
    model="claude-opus-4-7",
    max_tokens=4096,
    tools=[{"type": "code_execution_20250522", "name": "code_execution"}],
    messages=[{
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": "Load the CSV, compute monthly totals, and create a bar chart saved as monthly_totals.png",
            },
            {
                "type": "container_upload",
                "source": {
                    "type": "file",
                    "file_id": dataset.id,
                },
            },
        ],
    }],
    betas=["files-api-2025-04-14"],
)

# Extract the output file_id from the response
for block in response.content:
    if hasattr(block, "type") and block.type == "tool_result":
        for content in block.content:
            if hasattr(content, "file_id"):
                output_file_id = content.file_id
                print(f"Output chart file_id: {output_file_id}")
```

Now download the generated chart:

```python
# Download the generated chart
chart_content = client.beta.files.download(output_file_id)
chart_content.write_to_file("monthly_totals.png")
print("Chart downloaded to monthly_totals.png")
```

<RunPromptCell
  model="claude-opus-4-7"
  prompt="I have a CSV with columns: month, product, revenue. Using the code execution tool, compute the top 3 products by total revenue and create a horizontal bar chart. Return the file_id of the saved PNG."
  expectedOutput="Claude writes Python code using pandas and matplotlib. The code reads the CSV from the container, computes `.groupby('product')['revenue'].sum().nlargest(3)`, generates a horizontal bar chart with `plt.barh()`, saves it as `top_products.png`. The tool_result block includes a `file_id` for the output PNG that can be passed to `client.beta.files.download()`."
/>

## File lifecycle management

Files persist until you explicitly delete them. For production agents, you need a retention policy:

```python
import datetime

def cleanup_old_files(client: Anthropic, max_age_days: int = 30):
    """Delete files older than max_age_days."""
    files = client.beta.files.list()
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=max_age_days)
    
    deleted = 0
    for file in files.data:
        created = datetime.datetime.fromisoformat(file.created_at)
        if created < cutoff:
            client.beta.files.delete(file.id)
            deleted += 1
    
    return deleted
```

<Callout type="info">
The Files API rate limit is approximately 100 requests per minute during the beta period. If you're bulk-uploading documents at ingestion time, add a delay between uploads or batch them during off-peak windows. Contact sales@anthropic.com for higher limits.
</Callout>

## Extended prompt caching with Files API

When you use the same file across many Messages calls in a short window, extended prompt caching can significantly reduce costs. The standard cache TTL is 5 minutes; an optional 1-hour TTL is available:

```python
response = client.beta.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What are the payment terms?"},
            {
                "type": "document",
                "source": {"type": "file", "file_id": pdf_file.id},
                "cache_control": {"type": "ephemeral"},  # cache this document
            },
        ],
    }],
    betas=["files-api-2025-04-14", "prompt-caching-2024-07-31"],
)
```

With caching enabled, the first call to include a given `file_id` pays full input token cost. Subsequent calls within the TTL window pay cache read tokens — approximately 10% of the full input price for standard caching. For a 100-page PDF queried 50 times in one session, this can reduce document token costs by 85–90%.

The cache is keyed on the exact content. If the file's content changes (you re-upload), the cache key changes and you pay full tokens again. This is expected behavior: the cache reflects the actual bytes.

## Managing files at scale

For production agents that ingest documents regularly, you need patterns beyond "upload once." A document ingestion pipeline typically has three stages:

**Stage 1 — upload and register**:
```python
def ingest_document(file_path: str, metadata: dict) -> str:
    """Upload file, return file_id. Store mapping in your DB."""
    with open(file_path, "rb") as f:
        mime = "application/pdf" if file_path.endswith(".pdf") else "text/plain"
        uploaded = client.beta.files.upload(
            file=(os.path.basename(file_path), f, mime),
        )
    
    # Store in your DB: document_id → file_id mapping
    db.insert("documents", {
        "document_id": metadata["id"],
        "file_id": uploaded.id,
        "uploaded_at": datetime.utcnow().isoformat(),
        "filename": os.path.basename(file_path),
    })
    return uploaded.id
```

**Stage 2 — use by ID**:
```python
def query_document(document_id: str, question: str) -> str:
    """Look up file_id from DB, query without re-uploading."""
    row = db.find("documents", {"document_id": document_id})
    file_id = row["file_id"]
    
    response = client.beta.messages.create(
        model="claude-opus-4-7",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": question},
                {"type": "document", "source": {"type": "file", "file_id": file_id}},
            ],
        }],
        betas=["files-api-2025-04-14"],
    )
    return response.content[0].text
```

**Stage 3 — clean up stale files**:
```python
def sync_file_storage(max_age_days: int = 90):
    """Delete Files API objects for documents removed from DB."""
    all_files = {f.id for f in client.beta.files.list().data}
    active_ids = set(db.select_column("documents", "file_id"))
    
    stale = all_files - active_ids
    for file_id in stale:
        client.beta.files.delete(file_id)
    return len(stale)
```

The 500 GB per-organization limit seems generous until you have thousands of PDFs. Build the cleanup stage from day one.

## What the Files API does NOT support

Knowing the limits prevents surprises:

- **Not available on Bedrock or Vertex AI**: If your organization uses Claude through AWS or GCP, the Files API is not available. You'll need to pass file content inline in every request.
- **Downloaded files only from code execution / skills**: You cannot download a file you uploaded. The download endpoint works only for files that were created as outputs by the code execution tool or skills.
- **No ZDR**: If your organization has Zero Data Retention enabled, the Files API is ineligible. Files are stored until explicitly deleted regardless of ZDR settings.
- **Not an immutable store**: Files can be deleted by any API key in your workspace. There's no access control within a workspace.

<RunPromptCell
  model="claude-opus-4-7"
  prompt="I uploaded a PDF contract using the Files API. I now want to ask three questions about it: (1) what are the payment terms, (2) what are the termination conditions, and (3) who are the parties. Walk me through the most cost-efficient way to run all three queries."
  expectedOutput="Claude explains: upload the PDF once (free), then make three separate Messages API calls each referencing the same file_id. To minimize token cost, enable the 1-hour extended prompt caching TTL so the PDF tokens are cached after the first call — the second and third calls pay only cache read tokens (much cheaper) rather than full input tokens. Include citations: {enabled: true} to get inline references to specific clauses."
/>

## Hands-on exercise

**Build a document-analysis agent that uploads a PDF once and runs three analytical queries with a downloaded chart.**

Setup: Use any PDF you have — a research paper, a product manual, or a public SEC filing work well.

Steps:
1. Upload the PDF to the Files API, store the returned `file_id`
2. Run Query 1: "What is the main topic of this document? Summarize in 3 sentences."
3. Run Query 2: "List all named organizations, companies, or institutions mentioned."
4. Run Query 3: "What are the 5 most important numbers or statistics cited?" — with `citations: {enabled: true}`
5. After Query 3, verify all three calls used the same `file_id` (no re-upload)
6. **Bonus**: Add a code execution call that takes the organizations from Query 2 as a CSV and creates a simple word-frequency bar chart, then download the output PNG

**Verification**:
- The `file_id` in all three Messages requests is identical
- Query 3 response includes inline citations with page or section references
- (Bonus) You have a PNG file on your filesystem with a chart

**Estimated time**: 20 minutes (30 minutes with bonus)

<KnowledgeCheck
  question="A developer uploads a 2 MB PDF to the Files API and then uses the same file_id in 50 separate Messages API calls over one month. Which costs does she pay?"
  options={[
    "Zero for the upload; input tokens for each of the 50 Messages calls",
    "Zero for everything — Files API uploads and reads are free",
    "A one-time upload fee + zero for the 50 calls",
    "Input tokens once for the upload; zero for subsequent calls (cached)"
  ]}
  correctIdx={0}
  explanation="File operations (upload, download, list, delete) are free. However, each of the 50 Messages API calls that reference the file_id charges the PDF's content as input tokens — same as if she'd sent the bytes inline. The savings are bandwidth (no 2 MB per request) and latency. To reduce the per-call token cost, enable extended prompt caching so calls 2–50 pay cache read rates instead of full input rates."
/>

<KnowledgeCheck
  question="You want to download a PNG chart that Claude generated during a code execution call. Describe the correct sequence of API calls, including the beta headers needed."
  options={["self-check"]}
  correctIdx={0}
  explanation="Self-check: (1) Make a Messages API call with the code_execution tool enabled and the beta header `files-api-2025-04-14`. (2) In the response, find the tool_result block that contains a `file_id` for the generated output. (3) Call `GET /v1/files/{file_id}/content` with the header `anthropic-beta: files-api-2025-04-14` to download the PNG bytes. Note: you can only download files that were CREATED by code execution or skills — not files you uploaded yourself."
/>

## What's next

In Chapter 5 you'll harden everything built so far into production-ready agents. The focus shifts from capabilities to operations: structured logging with hooks, cost circuit breakers that stop runaway sessions, and the deployment checklist that prevents the most common production failures. The biggest surprise for most teams: model hallucination isn't the primary failure mode — it's uncontrolled token spend.

## References

[1] Files API — https://platform.claude.com/docs/en/build-with-claude/files · retrieved 2026-04-30
[2] Agent Capabilities API announcement — https://claude.com/blog/agent-capabilities-api · retrieved 2026-04-30
[3] Claude Managed Agents Tools — https://platform.claude.com/docs/en/managed-agents/tools · retrieved 2026-04-30
[4] Code Execution Tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool · retrieved 2026-04-30
[5] Anthropic Data Retention — https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention · retrieved 2026-04-30
