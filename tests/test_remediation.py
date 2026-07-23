from unittest.mock import MagicMock
from pr_shepherd.domain import PullRequest, Comment, FileChange, CheckRun
from pr_shepherd.config import ShepherdConfig
from pr_shepherd.remediation import RemediationEngine

def test_check_template_status():
    config = ShepherdConfig()
    remediator = RemediationEngine(config, MagicMock(), MagicMock())
    
    # 1. Empty body is missing sections
    ok, missing = remediator.check_template_status("")
    assert ok is False
    assert "Thinking Path" in missing
    assert "Dedup Checkbox" in missing

    # 2. Perfect body is OK
    perfect_body = """
## Thinking Path
Rationals...
## What Changed
List...
## Verification
Tests...
## Risks
None...
## Model Used
LLM...

- [x] I have searched for similar PRs to avoid duplication.
"""
    ok, missing = remediator.check_template_status(perfect_body)
    assert ok is True
    assert len(missing) == 0

def test_remediate_format_gate():
    config = ShepherdConfig()
    gh = MagicMock()
    llm = MagicMock()
    
    # Configure mock LLM output
    llm.generate_pr_description.return_value = "## Thinking Path\nMocked\n## What Changed\nMocked\n## Verification\nMocked\n## Risks\nMocked\n## Model Used\nMocked\n- [x] I have searched for similar PRs"
    
    remediator = RemediationEngine(config, gh, llm)
    
    pr = PullRequest(
        number=123, title="Fix template", body="Initial description", state="open", author="bot",
        labels=[], changed_files=[FileChange(filename="a.py", additions=1, deletions=1, patch="diff...")],
        comments=[], reviews=[],
        check_runs=[CheckRun(name="commitperclip", status="completed", conclusion="failure")],
        head_sha="sha", base_sha="base"
    )
    
    changed = remediator.remediate(pr)
    assert changed is True
    
    # Ensure description update & comments were posted
    gh.update_pr_description.assert_called_once_with(123, "Initial description\n\n## Thinking Path\nMocked\n## What Changed\nMocked\n## Verification\nMocked\n## Risks\nMocked\n## Model Used\nMocked\n- [x] I have searched for similar PRs")
    gh.post_comment.assert_called_with(123, "🤖 **PR-Shepherd Auto-Remediation**: Corrected missing template sections required by `commitperclip`.")

def test_remediate_reviewer_nits_as_comments():
    """Suggestions from trusted reviewers are posted as comments, and never committed to the repository."""
    config = ShepherdConfig()
    config.dry_run = False
    gh = MagicMock()
    llm = MagicMock()
    
    remediator = RemediationEngine(config, gh, llm)
    
    comment = Comment(
        id=999,
        body="Use a const here:\n```suggestion\nconst val = 10\n```",
        user="reviewer-bob",
        path="src/main.js",
        line=5,
        association="COLLABORATOR"
    )
    
    pr = PullRequest(
        number=456, title="Fix style", body="## Thinking Path\nDone\n## What Changed\nDone\n## Verification\nDone\n## Risks\nDone\n## Model Used\nDone\n- [x] I have searched for similar PRs",
        state="open", author="bot", labels=[],
        changed_files=[FileChange(filename="src/main.js", additions=10, deletions=5)],
        comments=[comment], reviews=[], check_runs=[], head_sha="sha", base_sha="base"
    )
    
    changed = remediator.remediate(pr)
    assert changed is True
    
    # Assert suggestion was posted as comment
    gh.post_comment.assert_called_once()
    posted_body = gh.post_comment.call_args[0][1]
    assert "Suggestion Detected" in posted_body
    assert "const val = 10" in posted_body
    
    # Verify no file changes or fetches occurred
    assert not hasattr(gh, "commit_file_change") or gh.commit_file_change.call_count == 0
    gh.get_file_contents.assert_not_called()

def test_remediate_untrusted_reviewer_nits():
    config = ShepherdConfig()
    config.dry_run = False
    gh = MagicMock()
    llm = MagicMock()
    
    remediator = RemediationEngine(config, gh, llm)
    
    # Suggestion from association="NONE" (untrusted)
    comment = Comment(
        id=999,
        body="Use a const here:\n```suggestion\nconst val = 10\n```",
        user="stranger",
        path="src/main.js",
        line=5,
        association="NONE"
    )
    
    pr = PullRequest(
        number=456, title="Fix style", body="## Thinking Path\nDone\n## What Changed\nDone\n## Verification\nDone\n## Risks\nDone\n## Model Used\nDone\n- [x] I have searched for similar PRs",
        state="open", author="bot", labels=[],
        changed_files=[FileChange(filename="src/main.js", additions=10, deletions=5)],
        comments=[comment], reviews=[], check_runs=[], head_sha="sha", base_sha="base"
    )
    
    changed = remediator.remediate(pr)
    assert changed is False
    gh.post_comment.assert_not_called()
    
def test_parse_suggestion_variants():
    config = ShepherdConfig()
    remediator = RemediationEngine(config, MagicMock(), MagicMock())
    
    # Suggestion with trailing lines
    body_with_nits = "Nit suggestion:\n```suggestion\nx = 5\ny = 10\n```\nLooks good otherwise."
    suggestion = remediator.parse_suggestion(body_with_nits)
    assert suggestion == "x = 5\ny = 10"
    
    # No suggestion
    assert remediator.parse_suggestion("Standard comment text.") is None
