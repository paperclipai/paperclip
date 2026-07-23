# Connector Template

Every connector should follow this contract:

```python
class Connector:
    name = "calendar"
    scopes = ["read_events", "draft_events"]
    risk = "medium"

    def healthcheck(self) -> dict: ...
    def search(self, query: str) -> list[dict]: ...
    def read(self, object_id: str) -> dict: ...
    def draft_action(self, payload: dict) -> dict: ...
    def execute_action(self, action_id: str, approval_token: str) -> dict: ...
```

Rules:

1. Read operations are preferred over writes.
2. Writes are drafted first when possible.
3. High-risk writes require approval.
4. All actions are logged.
5. Secrets never go into prompts.
```
