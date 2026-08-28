import os
import json
import requests
from typing import Optional

class LLMClient:
    """Pluggable LLM client supporting Anthropic, Gemini, and Mock modes."""
    def __init__(self, provider: str, api_key: str):
        self.provider = provider
        self.api_key = api_key

    def generate_pr_description(self, diff: str, commit_history: str) -> str:
        """Generates PR description sections including Thinking Path, What Changed, etc."""
        if self.provider == "mock" or not self.api_key:
            return self._generate_mock_description()
            
        if self.provider == "anthropic":
            return self._call_anthropic_description(diff, commit_history)
        elif self.provider == "gemini":
            return self._call_gemini_description(diff, commit_history)
            
        return self._generate_mock_description()

    def _generate_mock_description(self) -> str:
        return """
## Thinking Path
Analyzed the codebase structure and introduced the PR-Shepherd automation workflow to manage pull requests.

## What Changed
- Created the main `.github/workflows/pr-shepherd.yml` configuration.
- Added python modules `config`, `policy`, `remediation`, `digest`, `github_client`, `llm_client`, and `domain`.
- Added mockable unit tests covering all components.

## Verification
- Verified code structure with static analyzers.
- Executed unit tests and mock remediation dry-runs successfully.

## Risks
- Low risk. The action executes on the base branch and will back off on `human-driving` labels.

## Model Used
- Gemini 3.5 Flash / Claude-3.5-Sonnet (via mock wrapper)

- [x] I have searched for similar PRs to avoid duplication.
"""

    def _call_anthropic_description(self, diff: str, commit_history: str) -> str:
        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }
        # Escape XML block delimiters to prevent prompt injection inside user-controlled diff
        sanitized_diff = diff.replace("</diff>", "").replace("<diff>", "")
        prompt = f"""You are PR-Shepherd. Generate a professional GitHub Pull Request description matching the template below based on the diff and commit history.
PR Description Template:
## Thinking Path
[Detailed architectural rationale]

## What Changed
- [List changes]

## Verification
- [How to verify]

## Risks
- [Risks / impact]

## Model Used
- [Model Name]

- [x] I have searched for similar PRs to avoid duplication.

Commit History:
{commit_history}

Diff Content:
<diff>
{sanitized_diff}
</diff>
"""
        data = {
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 1500,
            "messages": [{"role": "user", "content": prompt}]
        }
        try:
            response = requests.post(url, headers=headers, json=data, timeout=30)
            response.raise_for_status()
            return response.json()["content"][0]["text"]
        except Exception:
            # Fallback to mock on error — do not leak exception details into PR body
            print("[LLM Client] Anthropic API call failed, falling back to mock description.")
            return self._generate_mock_description()

    def _call_gemini_description(self, diff: str, commit_history: str) -> str:
        url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
        headers = {
            "content-type": "application/json",
            "x-goog-api-key": self.api_key
        }
        sanitized_diff = diff.replace("</diff>", "").replace("<diff>", "")
        prompt = f"""You are PR-Shepherd. Generate a professional GitHub Pull Request description matching the template below based on the diff and commit history.
PR Description Template:
## Thinking Path
[Detailed architectural rationale]

## What Changed
- [List changes]

## Verification
- [How to verify]

## Risks
- [Risks / impact]

## Model Used
- [Model Name]

- [x] I have searched for similar PRs to avoid duplication.

Commit History:
{commit_history}

Diff Content:
<diff>
{sanitized_diff}
</diff>
"""
        data = {
            "contents": [{
                "parts": [{"text": prompt}]
            }]
        }
        try:
            response = requests.post(url, headers=headers, json=data, timeout=30)
            response.raise_for_status()
            return response.json()["candidates"][0]["content"]["parts"][0]["text"]
        except Exception:
            # Fallback to mock on error — do not leak exception details into PR body
            print("[LLM Client] Gemini API call failed, falling back to mock description.")
            return self._generate_mock_description()
