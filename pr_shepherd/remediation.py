import re
from typing import Optional, Tuple
from pr_shepherd.domain import PullRequest, Comment
from pr_shepherd.config import ShepherdConfig
from pr_shepherd.github_client import GitHubClient
from pr_shepherd.llm_client import LLMClient

class RemediationEngine:
    def __init__(self, config: ShepherdConfig, github_client: GitHubClient, llm_client: LLMClient):
        self.config = config
        self.gh = github_client
        self.llm = llm_client

    def parse_suggestion(self, comment_body: str) -> Optional[str]:
        """Extracts the suggestion code block from a review comment if present."""
        match = re.search(r"```suggestion\s*\n([\s\S]*?)```", comment_body)
        if match:
            return match.group(1).strip()
        return None

    def check_template_status(self, body: str) -> Tuple[bool, list]:
        """Verifies if the PR description contains the required commitperclip sections."""
        required_sections = ["Thinking Path", "What Changed", "Verification", "Risks", "Model Used"]
        missing = []
        for sec in required_sections:
            # Look for heading style headers
            pattern = rf"##\s*{re.escape(sec)}"
            if not re.search(pattern, body, re.IGNORECASE):
                missing.append(sec)
        
        # Check for dedup checkbox
        # Matches: [ ] or [x] with search for similar PRs
        dedup_pattern = r"\[[ xX]\]\s*I\s+have\s+searched\s+for\s+similar\s+PRs"
        if not re.search(dedup_pattern, body, re.IGNORECASE):
            missing.append("Dedup Checkbox")
            
        return len(missing) == 0, missing

    def remediate(self, pr: PullRequest) -> bool:
        """
        Executes the remediation flow.
        Returns True if any changes were made, False otherwise.
        """
        remediation_performed = False

        # 1. Format / Template Gate Remediation
        # Check if the commitperclip check has failed or if sections are missing
        has_commitperclip_failure = any(
            "commitperclip" in run.name.lower() and run.conclusion in ("failure", "action_required")
            for run in pr.check_runs
        )
        
        template_ok, missing_sections = self.check_template_status(pr.body)
        if has_commitperclip_failure or not template_ok:
            print(f"[Remediator] Format gate failure found. Missing sections: {missing_sections}")
            
            # Generate a new template body
            diff_text = "\n".join([f.patch for f in pr.changed_files if f.patch])
            # Simulated or actual commit messages
            commit_history = f"PR Title: {pr.title}\nAuthor: {pr.author}"
            
            new_sections = self.llm.generate_pr_description(diff_text, commit_history)
            
            # Combine the existing body with the new template sections
            updated_body = pr.body + "\n\n" + new_sections
            self.gh.update_pr_description(pr.number, updated_body)
            self.gh.post_comment(
                pr.number,
                "🤖 **PR-Shepherd Auto-Remediation**: Corrected missing template sections required by `commitperclip`."
            )
            remediation_performed = True

        # 2. Parse and Surface Reviewer Nits as Comments Only (No Auto-Committing)
        for comment in pr.comments:
            # Validate author trust level
            if comment.association not in ("OWNER", "COLLABORATOR", "MEMBER"):
                print(f"[Remediator] Skipping suggestion from untrusted user association: {comment.association}")
                continue

            suggestion = self.parse_suggestion(comment.body)
            if suggestion is not None and comment.path and comment.line is not None:
                print(f"[Remediator] Found suggestion comment from {comment.user} on {comment.path}:{comment.line}")
                
                # Surface suggestions via comment only — we do not commit file changes to V1 branches.
                self.gh.post_comment(
                    pr.number,
                    f"🤖 **PR-Shepherd Suggestion Detected** (from @{comment.user} on "
                    f"`{comment.path}:{comment.line}`):\n\n"
                    f"```suggestion\n{suggestion}\n```"
                )
                remediation_performed = True
                
        return remediation_performed
