import sys
import argparse
from pr_shepherd.config import ShepherdConfig
from pr_shepherd.github_client import GitHubClient
from pr_shepherd.llm_client import LLMClient
from pr_shepherd.policy import PolicyEngine
from pr_shepherd.remediation import RemediationEngine
from pr_shepherd.digest import DigestGenerator

def run_shepherd(pr_number: int, config: ShepherdConfig, gh_client: GitHubClient, llm_client: LLMClient, verify_actor: str = None):
    print(f"--- Running PR-Shepherd for PR #{pr_number} ---")
    
    # 1. Verify Actor if running in privileged 'act' mode
    if verify_actor:
        print(f"[Orchestrator] Gated act trigger. Verifying collaborator permission for actor: {verify_actor}")
        if not gh_client.has_write_permission(verify_actor):
            print(f"[Orchestrator] Security Abort: Actor '{verify_actor}' does not possess required write access.")
            sys.exit(1)
        print(f"[Orchestrator] Actor '{verify_actor}' is authorized.")

    # 2. Fetch Pull Request Data
    try:
        pr = gh_client.get_pull_request(pr_number)
    except Exception as e:
        print(f"Error fetching PR #{pr_number}: {e}")
        sys.exit(1)

    # 3. Evaluate Safety Policies
    policy = PolicyEngine(config)
    should_skip, is_merge_safe, hold_reasons = policy.evaluate(pr)

    if should_skip:
        print(f"Skipping PR #{pr_number}: Human has taken over ('human-driving' label present).")
        return

    # Handle Hold Cases
    if hold_reasons:
        print(f"PR #{pr_number} is held for human review due to:")
        for reason in hold_reasons:
            print(f"  - {reason}")
        
        # Apply 'needs-human' label (only if client has write permission)
        if "needs-human" not in pr.labels and config.auto_merge_enabled:
            try:
                gh_client.add_label(pr_number, "needs-human")
                gh_client.post_comment(
                    pr_number,
                    "🛑 **PR-Shepherd Hold**: This PR requires human review and has been labeled `needs-human`.\n\n**Reasons**:\n" + 
                    "\n".join([f"- {r}" for r in hold_reasons])
                )
            except Exception as e:
                print(f"Failed to post hold comment: {e}")
        return

    # Remove 'needs-human' if previously added and now green/safe
    if "needs-human" in pr.labels and config.auto_merge_enabled:
        try:
            gh_client.remove_label(pr_number, "needs-human")
        except Exception:
            pass

    # 4. Check for Auto-Merge (Enabled strictly in privileged act workflow config)
    if is_merge_safe:
        print(f"PR #{pr_number} is safe to merge.")
        success = gh_client.merge_pull_request(pr_number, pr.head_sha)
        if success:
            print(f"PR #{pr_number} successfully merged.")
        return

    # 5. Remediation Loop (Formatting and reviewer nits as comments only)
    remediator = RemediationEngine(config, gh_client, llm_client)
    if remediator.remediate(pr):
        print(f"Remediation changes applied/posted to PR #{pr_number}.")
    else:
        print(f"No remediation actions were necessary or applicable for PR #{pr_number}.")

def run_digest(config: ShepherdConfig, gh_client: GitHubClient):
    print("--- Running PR-Shepherd Digest Generation ---")
    merged_prs = []
    held_prs = {}
    
    if config.dry_run or not gh_client.is_active:
        # Mock digest data
        from pr_shepherd.domain import PullRequest
        # Simulate one auto-merged and one held
        merged_prs.append(PullRequest(
            number=8517, title="fix(db): watchdog the pg_dump pipeline",
            body="", state="closed", author="database-agent", labels=[],
            changed_files=[], comments=[], reviews=[], check_runs=[],
            head_sha="", base_sha=""
        ))
        held_prs[8516] = [
            "Touches sensitive path: server/auth.py",
            "Failing check run: superagent-security"
        ]
    else:
        # Actually fetch all open PRs and classify
        policy = PolicyEngine(config)
        
        for pr_raw in gh_client.get_open_pulls():
            try:
                pr = gh_client.get_pull_request(pr_raw["number"])
                should_skip, is_merge_safe, hold_reasons = policy.evaluate(pr)
                if should_skip:
                    continue
                if hold_reasons:
                    held_prs[pr.number] = hold_reasons
            except Exception as e:
                print(f"Error processing PR #{pr_raw['number']} for digest: {e}")

    # Generate the digest MD
    digest_gen = DigestGenerator(gh_client.repo_name)
    digest_md = digest_gen.generate_markdown(merged_prs, held_prs)
    
    print("\nGenerated Daily Digest:")
    print(digest_md)
    
    # In real runs, post this to the repository dashboard issue or log it
    if not config.dry_run and gh_client.is_active:
        try:
            gh_client.create_issue(title=config.digest_issue_title, body=digest_md)
            print("Digest issue successfully created on GitHub.")
        except Exception as e:
            print(f"Error creating digest issue: {e}")

def main():
    parser = argparse.ArgumentParser(description="PR-Shepherd Automation")
    parser.add_argument("--pr-number", type=int, help="Target PR number to process")
    parser.add_argument("--verify-actor", type=str, help="GitHub username who triggered the event, to verify write permission")
    parser.add_argument("--digest", action="store_true", help="Generate daily digest summary")
    args = parser.parse_args()

    config = ShepherdConfig()
    gh_client = GitHubClient(config)
    llm_client = LLMClient(config.llm_provider, config.llm_api_key)

    if args.pr_number:
        run_shepherd(args.pr_number, config, gh_client, llm_client, verify_actor=args.verify_actor)
    elif args.digest:
        run_digest(config, gh_client)
    else:
        parser.print_help()
        sys.exit(1)

if __name__ == "__main__":
    main()
