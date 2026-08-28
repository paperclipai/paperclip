import os
import base64
import requests as http_requests
from pr_shepherd.domain import PullRequest, FileChange, Comment, Review, CheckRun
from pr_shepherd.config import ShepherdConfig

class GitHubClient:
    """GitHub API client using only the requests library (no PyGithub dependency)."""
    API_BASE = "https://api.github.com"

    def __init__(self, config: ShepherdConfig, repo_name: str = ""):
        self.config = config
        self.repo_name = repo_name or os.environ.get("GITHUB_REPOSITORY", "octocat/Hello-World")
        self.token = config.github_token
        self._session = None

    @property
    def is_active(self):
        """True when we have a token and are not in dry-run mode."""
        return bool(self.token) and not self.config.dry_run

    @property
    def session(self):
        """Lazy-initialized requests session with auth headers."""
        if self._session is None:
            self._session = http_requests.Session()
            if self.token:
                self._session.headers.update({
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28"
                })
        return self._session

    def _api(self, method, path, **kwargs):
        """Make an authenticated GitHub API request."""
        url = f"{self.API_BASE}{path}"
        response = self.session.request(method, url, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else None

    def get_pull_request(self, pr_number: int) -> PullRequest:
        """Fetch full details of a pull request from GitHub API, or return a mock in dry-run mode."""
        if not self.is_active:
            return self._get_mock_pull_request(pr_number)

        pr = self._api("GET", f"/repos/{self.repo_name}/pulls/{pr_number}")

        # 1. Fetch file changes
        files = self._api("GET", f"/repos/{self.repo_name}/pulls/{pr_number}/files")
        changed_files = [
            FileChange(
                filename=f["filename"],
                additions=f.get("additions", 0),
                deletions=f.get("deletions", 0),
                patch=f.get("patch")
            )
            for f in files
        ]

        # 2. Fetch comments (both issue and pull request review comments)
        comments = []
        for c in self._api("GET", f"/repos/{self.repo_name}/issues/{pr_number}/comments"):
            comments.append(Comment(
                id=c["id"],
                body=c.get("body", ""),
                user=c["user"]["login"],
                association=c.get("author_association")
            ))
        for c in self._api("GET", f"/repos/{self.repo_name}/pulls/{pr_number}/comments"):
            comments.append(Comment(
                id=c["id"],
                body=c.get("body", ""),
                user=c["user"]["login"],
                path=c.get("path"),
                line=c.get("line"),
                in_reply_to_id=c.get("in_reply_to_id"),
                association=c.get("author_association")
            ))

        # 3. Fetch reviews
        reviews = [
            Review(
                id=r["id"],
                user=r["user"]["login"],
                state=r.get("state", ""),
                body=r.get("body", ""),
                association=r.get("author_association"),
                commit_id=r.get("commit_id")
            )
            for r in self._api("GET", f"/repos/{self.repo_name}/pulls/{pr_number}/reviews")
        ]

        # 4. Fetch check runs
        head_sha = pr["head"]["sha"]
        checks_resp = self._api("GET", f"/repos/{self.repo_name}/commits/{head_sha}/check-runs")
        check_runs = [
            CheckRun(
                name=run["name"],
                status=run.get("status", ""),
                conclusion=run.get("conclusion"),
                details_url=run.get("details_url")
            )
            for run in checks_resp.get("check_runs", [])
        ]

        # 5. Build and return PullRequest domain object
        return PullRequest(
            number=pr["number"],
            title=pr.get("title", ""),
            body=pr.get("body") or "",
            state=pr.get("state", ""),
            author=pr["user"]["login"],
            labels=[lbl["name"] for lbl in pr.get("labels", [])],
            changed_files=changed_files,
            comments=comments,
            reviews=reviews,
            check_runs=check_runs,
            head_sha=head_sha,
            base_sha=pr["base"]["sha"],
            mergeable=pr.get("mergeable")
        )

    def get_open_pulls(self):
        """Fetch all open pull requests (returns raw JSON list)."""
        if not self.is_active:
            return []
        return self._api("GET", f"/repos/{self.repo_name}/pulls", params={"state": "open"})

    def post_comment(self, pr_number: int, body: str) -> None:
        print(f"[GitHub Client] Posting comment on PR #{pr_number}: {body}")
        if not self.is_active:
            return
        self._api("POST", f"/repos/{self.repo_name}/issues/{pr_number}/comments", json={"body": body})

    def add_label(self, pr_number: int, label: str) -> None:
        print(f"[GitHub Client] Adding label '{label}' to PR #{pr_number}")
        if not self.is_active:
            return
        self._api("POST", f"/repos/{self.repo_name}/issues/{pr_number}/labels", json={"labels": [label]})

    def remove_label(self, pr_number: int, label: str) -> None:
        print(f"[GitHub Client] Removing label '{label}' from PR #{pr_number}")
        if not self.is_active:
            return
        try:
            self._api("DELETE", f"/repos/{self.repo_name}/issues/{pr_number}/labels/{label}")
        except Exception:
            pass  # Label might not exist

    def update_pr_description(self, pr_number: int, body: str) -> None:
        print(f"[GitHub Client] Updating description of PR #{pr_number}")
        if not self.is_active:
            return
        self._api("PATCH", f"/repos/{self.repo_name}/pulls/{pr_number}", json={"body": body})

    def has_write_permission(self, username: str) -> bool:
        """Verifies if a user currently has write, maintain, or admin permissions."""
        print(f"[GitHub Client] Verifying collaborator permissions for: {username}")
        if not self.is_active:
            # Under dry-run/mock conditions, mock collaborators are allowed
            return username in ("reviewer-bob", "alice", "bob")
        try:
            # Query collaborator permission endpoint
            result = self._api("GET", f"/repos/{self.repo_name}/collaborators/{username}/permission")
            # Permission levels matching write or above: write, maintain, admin
            perm = result.get("permission")
            print(f"[GitHub Client] Permission level for user '{username}': {perm}")
            return perm in ("write", "maintain", "admin")
        except Exception as e:
            print(f"[GitHub Client] Collaborator permission check failed for {username}: {e}")
            return False

    def merge_pull_request(self, pr_number: int, head_sha: str) -> bool:
        """Squash-merge a PR with atomic SHA verification.

        The ``sha`` field ensures GitHub rejects the merge if the HEAD has
        moved since the caller last evaluated the PR, preventing a
        race-condition merge of unreviewed commits.
        """
        print(f"[GitHub Client] Squashing and merging PR #{pr_number} (expected HEAD: {head_sha})")
        if not self.is_active:
            return True
        result = self._api("PUT", f"/repos/{self.repo_name}/pulls/{pr_number}/merge",
                           json={"merge_method": "squash", "sha": head_sha})
        return result.get("merged", False)

    def get_file_contents(self, filename: str, ref: str) -> str:
        """Retrieves content of a file at a specific git ref/SHA."""
        print(f"[GitHub Client] Fetching contents of '{filename}' at ref {ref}")
        if not self.is_active:
            # Return mock content for testing nits
            return "line 1\nline 2\nline 3\nline 4\nconst val = 5\nline 6\n"
        result = self._api("GET", f"/repos/{self.repo_name}/contents/{filename}", params={"ref": ref})
        return base64.b64decode(result["content"]).decode("utf-8")

    def create_issue(self, title: str, body: str) -> None:
        """Creates a new issue in the repository."""
        print(f"[GitHub Client] Creating issue: {title}")
        if not self.is_active:
            return
        self._api("POST", f"/repos/{self.repo_name}/issues", json={"title": title, "body": body})

    def _get_mock_pull_request(self, pr_number: int) -> PullRequest:
        """Helper returning mock PR data when in dry-run or no tokens are provided."""
        return PullRequest(
            number=pr_number,
            title="fix(server): wake creator agent when board user rejects request_confirmation",
            body="An agent PR that lacks template sections.",
            state="open",
            author="gemini-coder-agent",
            labels=[],
            changed_files=[
                FileChange(filename="server/main.py", additions=10, deletions=5, patch="@@ -10,5 +10,10 @@")
            ],
            comments=[
                Comment(
                    id=101,
                    body="Could you please use a different variable name here?\n```suggestion\nnew_var = 10\n```",
                    user="reviewer-bob",
                    path="server/main.py",
                    line=12,
                    association="COLLABORATOR"
                )
            ],
            reviews=[
                Review(id=201, user="reviewer-bob", state="COMMENTED", body="Reviewing the nits", association="COLLABORATOR", commit_id="abcdef123456")
            ],
            check_runs=[
                CheckRun(name="commitperclip", status="completed", conclusion="failure"),
                CheckRun(name="build-and-test", status="completed", conclusion="success")
            ],
            head_sha="abcdef123456",
            base_sha="123456abcdef"
        )
