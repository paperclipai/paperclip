"""Tests for memory CRUD operations."""

import pytest

from deerflow.agents.memory.storage import FileMemoryStorage, _create_empty_memory, get_memory_storage, set_memory_storage
from deerflow.agents.memory.updater import (
    clear_memory_data,
    delete_memory_fact,
    get_memory_data,
)


@pytest.fixture(autouse=True)
def _use_tmp_storage(tmp_path):
    """Use a temp-dir storage for every test."""
    storage = FileMemoryStorage(base_dir=tmp_path)
    set_memory_storage(storage)
    yield
    set_memory_storage(None)


def _seed_memory(facts=None):
    """Save memory with given facts."""
    data = _create_empty_memory()
    if facts:
        data["facts"] = facts
    get_memory_storage().save(data)
    return data


class TestClearMemory:
    def test_clear_resets_to_empty(self):
        _seed_memory([{"id": "f1", "content": "test", "category": "knowledge", "confidence": 0.9, "createdAt": "", "source": "t1"}])
        result = clear_memory_data()
        assert result is True
        data = get_memory_data()
        assert data["facts"] == []
        assert data["user"]["workContext"]["summary"] == ""

    def test_clear_when_already_empty(self):
        result = clear_memory_data()
        assert result is True


class TestDeleteFact:
    def test_delete_existing_fact(self):
        _seed_memory([
            {"id": "f1", "content": "keep", "category": "knowledge", "confidence": 0.9, "createdAt": "", "source": "t1"},
            {"id": "f2", "content": "delete me", "category": "knowledge", "confidence": 0.9, "createdAt": "", "source": "t1"},
        ])
        result = delete_memory_fact("f2")
        assert result is True
        data = get_memory_data()
        assert len(data["facts"]) == 1
        assert data["facts"][0]["id"] == "f1"

    def test_delete_nonexistent_fact_returns_false(self):
        _seed_memory([{"id": "f1", "content": "test", "category": "knowledge", "confidence": 0.9, "createdAt": "", "source": "t1"}])
        result = delete_memory_fact("nonexistent")
        assert result is False
