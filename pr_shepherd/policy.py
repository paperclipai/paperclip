import re
from typing import List, Tuple
from pr_shepherd.domain import PullRequest
from pr_shepherd.config import ShepherdConfig

def match_path(path: str, pattern: str) -> bool:
    """Helper to match glob patterns including double asterisks (**) correctly."""
    # Normalize paths
    path = path.replace("\\", "/")
    pattern = pattern.replace("\\", "/")
    
    # Simple direct match
    if pattern == path:
        return True
        
    # Translate glob to regex
    regex_parts = []
    # Split by double asterisk to handle recursive paths
    parts = pattern.split("**")
    for i, part in enumerate(parts):
        # Escape the non-glob characters in the part
        escaped = re.escape(part)
        # Replace escaped single asterisks with non-slash characters
        escaped = escaped.replace(r'\*', r'[^/]*')
        escaped = escaped.replace(r'\?', r'[^/]')
        regex_parts.append(escaped)
        if i < len(parts) - 1:
            regex_parts.append(r'.*')
            
    regex = "^" + "".join(regex_parts) + "$"
    return bool(re.match(regex, path))

class PolicyEngine:
    def __init__(self, config: ShepherdConfig):
        self.config = config

    def evaluate(self, pr: PullRequest) -> Tuple[bool, bool, List[str]]:
        """
        Evaluates the PR against safety policies.
        Returns:
            should_skip: True if human-driving label is present.
            is_merge_safe: True if all merge policy criteria are met.
            reasons_for_hold: List of reasons preventing auto-merge (leads to needs-human label).
        """
        # 1. Check for human override label
        if "human-driving" in pr.labels:
            return True, False, ["PR labeled with 'human-driving' - human has taken over."]

        reasons_for_hold = []

        # 2. Touch sensitive paths / files
        for change in pr.changed_files:
            # Check sensitive paths from config
            already_flagged = False
            for pattern in self.config.sensitive_paths:
                if match_path(change.filename, pattern):
                    reasons_for_hold.append(f"Touches sensitive path: {change.filename} (pattern: {pattern})")
                    already_flagged = True
                    break
            
            # Check DB migrations explicitly (*.sql or migrations/ in path)
            if not already_flagged and (change.filename.endswith(".sql") or "migrations/" in change.filename.lower()):
                reasons_for_hold.append(f"Touches DB migrations / SQL: {change.filename}")

        # 3. Check diff size and file count thresholds
        total_lines = sum(change.additions + change.deletions for change in pr.changed_files)
        if total_lines > self.config.diff_size_threshold:
            reasons_for_hold.append(f"Diff size ({total_lines} lines) exceeds threshold ({self.config.diff_size_threshold} lines).")
            
        if len(pr.changed_files) > self.config.file_count_threshold:
            reasons_for_hold.append(f"Number of files modified ({len(pr.changed_files)}) exceeds threshold ({self.config.file_count_threshold}).")

        # 4. Check for active block review requests & ensure at least one APPROVED review from a trusted user exists
        # Group reviews by user to see the latest status of each reviewer
        latest_reviews = {}
        reviewer_associations = {}
        latest_reviews_commit = {}
        for review in pr.reviews:
            latest_reviews[review.user] = review.state
            if review.association:
                reviewer_associations[review.user] = review.association
            if review.commit_id:
                latest_reviews_commit[review.user] = review.commit_id

        for user, state in latest_reviews.items():
            if state == "CHANGES_REQUESTED":
                assoc = reviewer_associations.get(user, "NONE")
                if assoc in ("OWNER", "COLLABORATOR", "MEMBER"):
                    reasons_for_hold.append(f"Reviewer {user} has outstanding changes requested.")

        # Find trusted approvals matching the current HEAD commit SHA
        trusted_approvals = []
        for user, state in latest_reviews.items():
            if state == "APPROVED":
                # Ensure the approval matches the current head SHA exactly (preempts stale approvals)
                if latest_reviews_commit.get(user) == pr.head_sha:
                    assoc = reviewer_associations.get(user, "NONE")
                    if assoc in ("OWNER", "COLLABORATOR", "MEMBER"):
                        trusted_approvals.append(user)

        if not trusted_approvals:
            reasons_for_hold.append(f"PR requires at least one APPROVED review matching current HEAD ({pr.head_sha}) from a trusted reviewer (OWNER, COLLABORATOR, or MEMBER).")

        # 5. Check security flags
        if "pr:flagged" in pr.labels:
            reasons_for_hold.append("PR carries the 'pr:flagged' label.")

        # Scan for superagent-security status in checks
        for run in pr.check_runs:
            if "superagent-security" in run.name.lower():
                if run.conclusion in ("failure", "action_required"):
                    reasons_for_hold.append("Security check 'superagent-security' has failed.")

        # 6. Check required checks are green
        failing_checks = []
        for run in pr.check_runs:
            # If the run is completed and failed
            if run.status == "completed" and run.conclusion in ("failure", "action_required", "timed_out"):
                # Exception: format/template gate failures are remediable and not immediate blocks for holds,
                # unless they fail after remediation. Let's record them.
                if "commitperclip" in run.name.lower():
                    # We flag it as failing but we'll try to remediate it if not held by other policies
                    pass
                else:
                    failing_checks.append(run.name)

        if failing_checks:
            reasons_for_hold.append(f"Failing required checks: {', '.join(failing_checks)}")

        # Auto-merge safety logic
        # Must be enabled in config, have zero hold reasons, and all required checks must be green
        has_failed_commitperclip = any("commitperclip" in r.name.lower() and r.conclusion in ("failure", "action_required") for r in pr.check_runs)
        all_completed = all(run.status == "completed" for run in pr.check_runs)
        all_success = all(run.conclusion == "success" for run in pr.check_runs)
        
        is_merge_safe = (
            self.config.auto_merge_enabled and
            not reasons_for_hold and
            not has_failed_commitperclip and
            len(pr.check_runs) > 0 and
            all_completed and
            all_success
        )

        return False, is_merge_safe, reasons_for_hold
