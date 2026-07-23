import os
import tempfile
from pathlib import Path
import pytest

from replay_runner import discover_fixtures, run_fixture, assert_expected

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "replay"

if FIXTURES_ROOT.exists():
    _FIXTURES = discover_fixtures(FIXTURES_ROOT)
else:
    _FIXTURES = []


@pytest.mark.parametrize("fixture_dir", _FIXTURES, ids=[f.name for f in _FIXTURES] or ["_none"])
def test_replay(fixture_dir):
    if not _FIXTURES:
        pytest.skip("no replay fixtures yet")
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "replay.db"
        actual = run_fixture(fixture_dir, db_path)
        assert_expected(fixture_dir, actual)
