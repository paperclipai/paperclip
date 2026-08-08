from pr_shepherd.domain import PullRequest
from pr_shepherd.digest import DigestGenerator

def test_generate_empty_digest():
    generator = DigestGenerator(repo_name="my/repo")
    md = generator.generate_markdown(merged_prs=[], held_prs={})
    
    assert "Auto-merged today: **0**" in md
    assert "Waiting on owner: **0**" in md
    assert "_No pull requests were auto-merged today._" in md
    assert "_No pull requests are currently blocked or waiting on human action._" in md

def test_generate_digest_with_entries():
    generator = DigestGenerator(repo_name="my/repo")
    
    merged = [
        PullRequest(
            number=101, title="fix(auth): correct token expire", body="", state="closed",
            author="auth-agent", labels=[], changed_files=[], comments=[], reviews=[],
            check_runs=[], head_sha="", base_sha=""
        )
    ]
    held = {
        102: ["Touches DB migrations / SQL: schema.sql", "Failing required checks: lint"],
        103: ["Reviewer bob has outstanding changes requested."]
    }
    
    md = generator.generate_markdown(merged, held)
    assert "Auto-merged today: **1**" in md
    assert "Waiting on owner: **2**" in md
    assert "[#101](https://github.com/my/repo/pull/101)" in md
    assert "[#102](https://github.com/my/repo/pull/102)" in md
    assert "Touches DB migrations / SQL: schema.sql" in md
    assert "Failing required checks: lint" in md
    assert "Reviewer bob has outstanding changes requested." in md
