import os
import tempfile
import pytest
from state_store import open_db, init_schema

@pytest.fixture
def fresh_db():
    """Yield a path to a fresh SQLite DB with the schema applied."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    init_schema(path)
    yield path
    os.remove(path)
