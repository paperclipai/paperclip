import os
import yaml

def test_workflow_jobs_and_triggers_isolation():
    """Validates that GHA job privileges align with secure trigger patterns.

    This prevents regressions where broad triggers (e.g. issue comments, check runs)
    accidentally invoke jobs with write access or repository credentials persistence.
    """
    workflow_path = os.path.join(
        os.path.dirname(__file__), "..", ".github", "workflows", "pr-shepherd.yml"
    )
    assert os.path.exists(workflow_path), f"Workflow file not found at: {workflow_path}"

    with open(workflow_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    # 1. Trigger Verification: Broad/manipulatable triggers must NOT be configured
    triggers = data.get("on", {})
    assert "issue_comment" not in triggers
    assert "pull_request_review_comment" not in triggers
    assert "check_suite" not in triggers
    assert "workflow_run" not in triggers

    # 2. Permissions Separation
    jobs = data.get("jobs", {})
    assert "evaluate" in jobs
    assert "act" in jobs

    # evaluate job must be strictly read-only
    evaluate_perms = jobs["evaluate"].get("permissions", {})
    assert evaluate_perms.get("contents") == "read"
    assert evaluate_perms.get("pull-requests") == "read"

    # evaluate job must not contain write privileges
    for perm_key, perm_val in evaluate_perms.items():
        assert perm_val in ("read", "none"), f"Unprivileged 'evaluate' job contains write permission: {perm_key}"

    # 3. act job Gating, Permissions, and Checkouts
    act_job = jobs["act"]
    # Verify act permissions do not contain issues: write
    act_perms = act_job.get("permissions", {})
    assert "issues" not in act_perms, "Privileged 'act' job contains unused issues permission"

    # Check execution gate (if: condition)
    act_if = act_job.get("if", "")
    assert "github.event.action == 'labeled'" in act_if
    assert "github.event.label.name == 'shepherd:merge'" in act_if
    assert "github.event.sender.type == 'User'" in act_if

    # Check git checkouts persist-credentials settings
    for step in act_job.get("steps", []):
        if step.get("uses", "").startswith("actions/checkout"):
            step_with = step.get("with", {})
            assert step_with.get("persist-credentials") is False
            assert "default_branch" in str(step_with.get("ref", ""))
