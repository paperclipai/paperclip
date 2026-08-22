from pr_shepherd.config import ShepherdConfig
from pr_shepherd.github_client import GitHubClient

def test_github_client_dry_run_fallback():
    config = ShepherdConfig()
    config.dry_run = True
    client = GitHubClient(config, repo_name="foo/bar")
    
    pr = client.get_pull_request(123)
    assert pr.number == 123
    assert pr.author == "gemini-coder-agent"
    assert len(pr.changed_files) == 1
    assert pr.changed_files[0].filename == "server/main.py"
    assert len(pr.comments) == 1
    assert "suggestion" in pr.comments[0].body
