"""Tests for the cache layer."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from blackbox.cache import CacheManager
from blackbox.models import AgencyDossier, RFPContext


def _make_dossier(name: str = "FDA") -> AgencyDossier:
    return AgencyDossier(
        agency_name=name,
        rfp_context=RFPContext(agency_name=name),
    )


class TestCacheManager:
    def test_miss_returns_none(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        assert cache.get("FDA") is None

    def test_put_then_get(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        dossier = _make_dossier()
        cache.put("FDA", dossier)
        result = cache.get("FDA")
        assert result is not None
        assert result.agency_name == "FDA"

    def test_expired_returns_none(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        dossier = _make_dossier()
        cache.put("FDA", dossier)
        # Manually set expires_at to the past
        path = cache._cache_path("FDA")
        data = json.loads(path.read_text())
        data["expires_at"] = (datetime.now(tz=UTC) - timedelta(days=1)).isoformat()
        path.write_text(json.dumps(data))
        assert cache.get("FDA") is None

    def test_corrupt_json_returns_none(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir(parents=True)
        (cache_dir / "fda.json").write_text("not valid json{{{")
        assert cache.get("FDA") is None

    def test_put_creates_dir(self, tmp_path):
        cache_dir = tmp_path / "deep" / "nested" / "cache"
        cache = CacheManager(cache_dir, ttl_days=30)
        cache.put("FDA", _make_dossier())
        assert cache_dir.exists()

    def test_list_entries(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        cache.put("FDA", _make_dossier("FDA"))
        cache.put("Texas DIR", _make_dossier("Texas DIR"))
        entries = cache.list_entries()
        assert len(entries) == 2
        agencies = {e["agency"] for e in entries}
        assert "fda" in agencies
        assert "texas-dir" in agencies

    def test_list_empty(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        assert cache.list_entries() == []

    def test_clear_all(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        cache.put("FDA", _make_dossier("FDA"))
        cache.put("EPA", _make_dossier("EPA"))
        count = cache.clear()
        assert count == 2
        assert cache.list_entries() == []

    def test_clear_specific(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        cache.put("FDA", _make_dossier("FDA"))
        cache.put("EPA", _make_dossier("EPA"))
        count = cache.clear("FDA")
        assert count == 1
        entries = cache.list_entries()
        assert len(entries) == 1

    def test_clear_nonexistent_returns_zero(self, tmp_path):
        cache = CacheManager(tmp_path / "cache", ttl_days=30)
        assert cache.clear("nonexistent") == 0

    def test_cache_key_slugify(self, tmp_path):
        cache = CacheManager(tmp_path / "cache")
        assert cache._cache_key("Texas Department of Information Resources") == "texas-department-of-information-resources"
        assert cache._cache_key("FDA") == "fda"
        assert cache._cache_key("  Spaces & Symbols!  ") == "spaces-symbols"
