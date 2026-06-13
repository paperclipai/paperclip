import os
import tempfile
import pytest
from state_store import open_db, init_schema


@pytest.fixture
def fresh_db():
    """Yield a path to a fresh SQLite DB with the schema applied.

    Uses TemporaryDirectory so WAL sidecar files (-wal, -shm) get cleaned up too.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "state.db")
        init_schema(path)
        yield path
