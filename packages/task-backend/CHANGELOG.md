# @paperclipai/task-backend

## 0.1.0

### Initial Release

- Added `TaskBackend` interface defining the contract for task backends
- Added `PaperclipBackend` class implementing `TaskBackend` for Paperclip's native database
- CRUD operations: `createIssue`, `getIssue`, `updateIssue`, `deleteIssue`, `listIssues`
- Checkout/Release: `checkout`, `release` for agent assignment
- Comments: `addComment`, `listComments`
- Status transitions: `transitionStatus` with validation
- Dependencies: Stubbed methods (`addDependency`, `removeDependency`, `getDependencies`, `canProceed`) - will be implemented in a future phase
- Type definitions: `Issue`, `IssueStatus`, `IssuePriority`, `IssueQuery`, `IssueList`, `Comment`, `DependencyInfo`
