# GraphQL Queries Reference

Useful GitHub GraphQL queries for working with PR review threads.

## Fetch unresolved review threads (with pagination)

```graphql
query($cursor: String) {
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          comments(first: 3) {
            nodes {
              body
              path
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}
```

Pass `-f cursor=ENDCURSOR` on subsequent requests if `hasNextPage` is `true`.

## Resolve a single review thread

```graphql
mutation {
  resolveReviewThread(input: {threadId: "THREAD_ID"}) {
    thread { isResolved }
  }
}
```

## Batch-resolve multiple threads

Use GraphQL aliases to resolve several threads in one request:

```graphql
mutation {
  t1: resolveReviewThread(input: {threadId: "THREAD_ID_1"}) {
    thread { isResolved }
  }
  t2: resolveReviewThread(input: {threadId: "THREAD_ID_2"}) {
    thread { isResolved }
  }
  t3: resolveReviewThread(input: {threadId: "THREAD_ID_3"}) {
    thread { isResolved }
  }
}
```

## Fetch PR details (REST)

```bash
gh pr view <PR_NUMBER> --json title,body,state,reviews,comments,headRefName,statusCheckRollup
```

## Fetch inline review comments (REST)

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
```
