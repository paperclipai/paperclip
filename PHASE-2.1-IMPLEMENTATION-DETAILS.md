# Phase 2.1: Implementation Details - Sprint Artifact Parsers

## File Locations (Absolute Paths)

All files are located under `/Volumes/JS-DEV/paperclip/packages/shared/src/`

### Parsers
- `/parsers/sprint-plan.ts` - 5.4 KB, 239 lines
- `/parsers/task-breakdown.ts` - 9.1 KB, 347 lines
- `/parsers/handoff.ts` - 8.3 KB, 322 lines
- `/parsers/eval-report.ts` - 7.5 KB, 291 lines
- `/parsers/sprint-report.ts` - 9.1 KB, 359 lines

### Type Definitions
- `/types/sprint-artifacts.ts` - 4.2 KB, 142 lines (NEW)
- `/types/index.ts` - UPDATED: +14 lines (added exports)

### Tests
- `/parsers/sprint-plan.test.ts` - 4.8 KB, 193 lines, 10 tests
- `/parsers/task-breakdown.test.ts` - 5.5 KB, 219 lines, 12 tests
- `/parsers/handoff.test.ts` - 6.2 KB, 249 lines, 12 tests
- `/parsers/eval-report.test.ts` - 7.3 KB, 291 lines, 15 tests
- `/parsers/sprint-report.test.ts` - 7.8 KB, 313 lines, 14 tests

### Test Fixtures
- `/parsers/__fixtures__/sample-sprint-plan.md` - 1.1 KB
- `/parsers/__fixtures__/sample-task-breakdown.md` - 1.9 KB
- `/parsers/__fixtures__/sample-handoff-alpha.md` - 1.1 KB
- `/parsers/__fixtures__/sample-eval-pass.md` - 1.3 KB
- `/parsers/__fixtures__/sample-eval-fail.md` - 1.6 KB
- `/parsers/__fixtures__/sample-sprint-report.md` - 1.9 KB

### Main Exports
- `/parsers/index.ts` - 630 bytes (NEW)
- `/index.ts` - UPDATED: +22 lines (added parser exports)

---

## Parser Implementation Notes

### 1. parseSprintPlan()

**Input**: Markdown string containing sprint plan
**Output**: ParsingResult<SprintPlanData>

**Parsing Strategy**:
- Uses regex to find section headers (#, ##, ###)
- `extractSection()` finds content between headers
- `extractField()` parses key: value pairs
- `parseList()` extracts bullet/numbered lists
- `parseVLabelBreakdown()` handles table parsing with regex

**Key Functions**:
```typescript
extractSection(content: string, headerName: string, lines?: number): string
extractField(section: string, fieldName: string): string
parseList(content: string): string[]
parseVLabelBreakdown(content: string): VLabelBreakdown
```

**Error Handling**:
- Returns errors array for missing sprint ID, brief, product name
- Gracefully handles missing sections by returning empty strings
- No exceptions thrown

---

### 2. parseTaskBreakdown()

**Input**: Markdown string containing task table or list
**Output**: ParsingResult<Task[]>

**Parsing Strategy**:
- Tries markdown table format first
- Falls back to list format if no table found
- Table parsing: identifies headers, parses rows, maps to Task objects
- List parsing: looks for task headers (-, ##, ###) and properties

**Key Functions**:
```typescript
parseTaskTable(content: string): Task[]
parseTaskList(content: string): Task[]
parseTaskRow(row: string[], headers: string[]): Task | null
parseListField(content: string): string[]
normalizeVLabel(value: string): "V1" | "V2" | "V3"
```

**Validation**:
- Requires both task ID and title
- Accepts multiple naming conventions (ID, Task ID, task id)
- Normalizes V-labels (V1, v1, VERSION1 → V1)
- Handles comma-separated and markdown lists for arrays

---

### 3. parseHandoff()

**Input**: Markdown string containing engineer handoff
**Output**: ParsingResult<HandoffData>

**Parsing Strategy**:
- Extracts metadata fields (Task ID, Engineer, Feature, Status)
- Parses section headers to find Files Changed, Known Issues sections
- Attempts to parse evaluation scores from table or field format
- Tries to extract git commit hash
- Gracefully handles missing evaluation section

**Key Functions**:
```typescript
extractField(content: string, fieldName: string): string
extractSection(content: string, headerName: string): string
extractTaskIdFromTitle(content: string): string
parseStatus(statusValue: string): "complete" | "partial" | "failed"
parseFilesList(content: string): string[]
parseSelfEvaluationScores(content: string): SelfEvaluationScores
parseScoreField(content: string, fieldName: string): number
```

**Error Handling**:
- Flags missing task ID, engineer name, or scores
- Accepts both table and field formats for scores
- Defaults to "partial" status if unclear
- Returns 0 for missing score fields

---

### 4. parseEvalReport()

**Input**: Markdown string containing QA evaluation report
**Output**: ParsingResult<EvalReportData>

**Parsing Strategy**:
- Similar to handoff parsing for scores
- Implements strict pass/fail logic: `determinePassResult()`
- Extracts test evidence section (preserves bullet points)
- Parses required fixes as list
- Extracts evaluator name and timestamp

**Key Functions**:
```typescript
parseEvalScores(content: string): EvalScores
determinePassResult(scores: EvalScores): boolean
extractScoreFromContent(content: string, pattern: string, defaultValue: number): number
parseScoreField(content: string, fieldName: string): number
```

**Pass/Fail Logic**:
```
PASS if: total >= 24 AND all ≥ 6
FAIL otherwise
```

**Score Ranges**: Each criterion is 0-10 (max total 40)

---

### 5. parseSprintReport()

**Input**: Markdown string containing sprint report
**Output**: ParsingResult<SprintReportData>

**Parsing Strategy**:
- Extracts sprint ID, deployment URL, deployment time
- Parses "Features Shipped" table
- Parses "Features Dropped" table or list
- Handles multiple list formats:
  - `- ID: Title — Reason`
  - `- ID: Title (Reason)`
  - Table format with columns
- Extracts summary section for narrative

**Key Functions**:
```typescript
parseFeaturesTable(content: string, sectionName: string): ShippedFeature[]
parseShippedFeaturesFromContent(content: string): ShippedFeature[]
parseDroppedFeaturesTable(content: string): DroppedFeature[]
parseDroppedFeaturesFromContent(content: string): DroppedFeature[]
parseDroppedFeatureFromListItem(item: string): DroppedFeature | null
```

**Flexibility**:
- Handles multiple section name variations
- Supports both table and list formats
- Normalizes status field (partial vs shipped)
- Optional engineer field in shipped features

---

## Type Definitions Summary

### ParsingResult<T>
Generic wrapper for all parse results:
```typescript
interface ParsingResult<T> {
  data: T | null
  errors: ParsingError[]
  isValid: boolean
}
```

### ParsingError
Error information with context:
```typescript
interface ParsingError {
  message: string
  lineNumber?: number
  section?: string
}
```

### Score Criteria Interfaces
Consistent 4-criteria scoring system:
```typescript
interface SelfEvaluationScores {
  functionality: number
  codeQuality: number
  testing: number
  documentation: number
}

interface EvalScores {
  functionality: number
  codeQuality: number
  testing: number
  documentation: number
}
```

---

## Error Handling Philosophy

### Defensive Design
- No exceptions thrown (try/catch in main function)
- Graceful degradation for missing sections
- Returns empty values instead of null
- Accumulates all errors for reporting

### Error Messages
- Include section name (e.g., "metadata", "evaluation")
- Describe what was expected
- Suggest next steps implicitly through structure

### Validation Levels
1. **Required fields**: Flagged as errors if missing
2. **Recommended fields**: Returned as empty if missing
3. **Optional fields**: No error, just empty/default value

---

## Testing Strategy

### Test Organization
- One test file per parser
- Organized by functionality
- Uses vitest (built-in to monorepo)
- Fixtures loaded from __fixtures__ directory

### Test Patterns
```typescript
// 1. Happy path with fixture file
const content = readFileSync(resolve(__dirname, "__fixtures__/..."), "utf-8")
const result = parseX(content)
expect(result.isValid).toBe(true)

// 2. Edge case with inline content
const content = "minimal content"
const result = parseX(content)
expect(result.errors).toBeDefined()

// 3. Boundary conditions
const scores = { functionality: 6, ... }
expect(determinePassResult(scores)).toBe(true)
```

### Coverage Areas
- Happy path (complete, valid documents)
- Missing required fields
- Malformed markdown
- Empty documents
- Alternative formats (table vs list, different separators)
- Boundary values (especially for pass/fail)
- Type normalization (V-labels, status values)

---

## Integration Points

### Exported from @paperclipai/shared
All of the following are exported from the main package index:

**Parser Functions**:
```typescript
export { parseSprintPlan }
export { parseTaskBreakdown }
export { parseHandoff }
export { parseEvalReport, determinePassResult }
export { parseSprintReport }
```

**Type Definitions**:
```typescript
export type { SprintPlanData, VLabelBreakdown }
export type { Task }
export type { HandoffData, SelfEvaluationScores }
export type { EvalReportData, EvalScores }
export type { SprintReportData, ShippedFeature, DroppedFeature }
export type { ParsingError, ParsingResult }
```

### Usage Example
```typescript
import {
  parseSprintPlan,
  parseTaskBreakdown,
  type SprintPlanData,
  type Task,
} from "@paperclipai/shared"

const planResult = parseSprintPlan(planContent)
if (planResult.isValid) {
  const plan: SprintPlanData = planResult.data!
  // Use plan
}

const tasksResult = parseTaskBreakdown(tasksContent)
const tasks: Task[] = tasksResult.data || []
// Use tasks (empty array if parsing failed)
```

---

## Performance Characteristics

### Parsing Time (Estimated)
- Small documents (< 5 KB): < 5ms
- Medium documents (5-20 KB): 5-15ms
- Large documents (> 20 KB): 15-50ms

### Memory Usage
- No streaming (full document loaded)
- Regex operations are memory-efficient
- No dependency trees (no external libraries)

### Scalability
- Linear time complexity O(n) where n = document size
- Single-pass parsing
- No recursive depth issues
- Safe for typical sprint artifact sizes (< 100 KB)

---

## No External Dependencies

All parsers use only:
- JavaScript built-in string methods
- JavaScript RegExp for pattern matching
- Node.js fs module (for tests only)
- Node.js path module (for tests only)

**Zero production dependencies** - parsers are lightweight and portable.

---

## Next Phase Readiness

### For Phase 2.2 (Generators)
- All parsers are ready to be consumed
- Type definitions match generator output structures
- Error handling allows generators to gracefully handle bad input
- Fixtures can be used to test generators against

### For Phase 2.3 (Integration)
- ParsingResult wrapper allows adding metadata
- ParsingError interface supports workflow logging
- Structured output enables database persistence
- Type safety prevents runtime errors

---

## Running the Tests

```bash
# From monorepo root
cd /Volumes/JS-DEV/paperclip

# Run all parser tests
pnpm test -- parsers

# Run specific test file
pnpm test -- sprint-plan.test.ts

# Run with coverage
pnpm test -- parsers --coverage

# Run in watch mode
pnpm test -- parsers --watch
```

Expected output: All 63 tests passing with no warnings or errors.
