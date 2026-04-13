"""Tests for memory CRUD operations."""

import pytest

from deerflow.agents.memory.storage import FileMemoryStorage, _create_empty_memory, get_memory_storage, set_memory_storage
from deerflow.agents.memory.updater import (
    clear_memory_data,
    create_memory_fact,
    delete_memory_fact,
    get_memory_data,
    update_memory_fact,
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


class TestCreateFact:
    def test_create_fact_appends(self):
        _seed_memory()
        fact = create_memory_fact("User likes Python", "preference", 0.9)
        assert fact["content"] == "User likes Python"
        assert fact["category"] == "preference"
        assert fact["confidence"] == 0.9
        assert fact["id"].startswith("fact_")
        data = get_memory_data()
        assert len(data["facts"]) == 1

    def test_create_fact_invalid_category_raises(self):
        _seed_memory()
        with pytest.raises(ValueError, match="category"):
            create_memory_fact("test", "invalid_cat", 0.9)

    def test_create_fact_empty_content_raises(self):
        _seed_memory()
        with pytest.raises(ValueError, match="content"):
            create_memory_fact("", "knowledge", 0.9)

    def test_create_fact_confidence_out_of_range_raises(self):
        _seed_memory()
        with pytest.raises(ValueError, match="(?i)confidence"):
            create_memory_fact("test", "knowledge", 1.5)


class TestUpdateFact:
    def test_update_content(self):
        _seed_memory([{"id": "f1", "content": "old", "category": "knowledge", "confidence": 0.9, "createdAt": "", "source": "t1"}])
        result = update_memory_fact("f1", content="new")
        assert result is not None
        assert result["content"] == "new"
        assert result["category"] == "knowledge"

    def test_update_category(self):
        _seed_memory([{"id": "f1", "content": "test", "category": "knowledge", "confidence": 0.9, "createdAt": "", "source": "t1"}])
        result = update_memory_fact("f1", category="preference")
        assert result["category"] == "preference"

    def test_update_nonexistent_returns_none(self):
        _seed_memory()
        result = update_memory_fact("nonexistent", content="x")
        assert result is None

    def test_update_invalid_category_raises(self):
        _seed_memory([{"id": "f1", "content": "test", "category": "knowledge", "confidence": 0.9, "createdAt": "", "source": "t1"}])
        with pytest.raises(ValueError, match="category"):
            update_memory_fact("f1", category="bad")
