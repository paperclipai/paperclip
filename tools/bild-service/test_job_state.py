import os
import tempfile

import job_state


def setup_tmp():
    fd, path = tempfile.mkstemp()
    os.close(fd)
    os.remove(path)
    job_state.STATE_FILE = path
    return path


def test_add_and_read_back():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    jobs = job_state.all()
    assert list(jobs.keys()) == ["issue-1"]
    assert jobs["issue-1"]["prompt_id"] == "prompt-1"
    assert jobs["issue-1"]["company_id"] == "company-a"
    assert jobs["issue-1"]["attempts"] == 1


def test_survives_restart():
    path = setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    job_state.STATE_FILE = path          # simuliert Neustart: neu von Platte lesen
    assert job_state.get("issue-1")["prompt_id"] == "prompt-1"


def test_drop_removes_job():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    job_state.drop("issue-1")
    assert job_state.all() == {}
    assert job_state.get("issue-1") is None


def test_drop_unknown_job_is_silent():
    setup_tmp()
    job_state.drop("gibtsnicht")
    assert job_state.all() == {}


def test_bump_attempt_increments_and_replaces_prompt_id():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    n = job_state.bump_attempt("issue-1", "prompt-2", now=2000.0)
    assert n == 2
    job = job_state.get("issue-1")
    assert job["prompt_id"] == "prompt-2"
    assert job["submitted_at"] == 2000.0


def test_age_seconds():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    assert job_state.age_seconds(job_state.get("issue-1"), now=1300.0) == 300.0


def test_jobs_do_not_disturb_cost_keys():
    path = setup_tmp()
    import cost_state
    cost_state.STATE_FILE = path
    cost_state.record("2026-08-02", "medium")
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    assert cost_state.remaining_today("2026-08-02") == cost_state.DAILY_IMAGE_LIMIT - 1
    assert job_state.get("issue-1") is not None
