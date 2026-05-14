"""File-based agency dossier cache with TTL."""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

from blackbox.models import AgencyDossier

logger = logging.getLogger(__name__)


class CacheManager:
    def __init__(self, cache_dir: Path, ttl_days: int = 30) -> None:
        self.cache_dir = cache_dir
        self.ttl_days = ttl_days

    def _cache_key(self, agency_name: str) -> str:
        slug = agency_name.lower().strip()
        slug = re.sub(r"[^a-z0-9]+", "-", slug)
        return slug.strip("-")

    def _cache_path(self, agency_name: str) -> Path:
        return self.cache_dir / f"{self._cache_key(agency_name)}.json"

    def get(self, agency_name: str) -> AgencyDossier | None:
        path = self._cache_path(agency_name)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text())
            expires_at = datetime.fromisoformat(data["expires_at"])
            if datetime.now(tz=UTC) > expires_at:
                logger.debug("Cache expired for %s", agency_name)
                return None
            return AgencyDossier.model_validate(data["dossier"])
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            logger.warning("Corrupt cache entry for %s: %s", agency_name, exc)
            return None

    def put(
        self, agency_name: str, dossier: AgencyDossier, ttl_days: int | None = None
    ) -> None:
        ttl = ttl_days if ttl_days is not None else self.ttl_days
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            now = datetime.now(tz=UTC)
            payload = {
                "cache_key": self._cache_key(agency_name),
                "created_at": now.isoformat(),
                "expires_at": (now + timedelta(days=ttl)).isoformat(),
                "dossier": json.loads(dossier.model_dump_json()),
            }
            self._cache_path(agency_name).write_text(
                json.dumps(payload, indent=2, default=str)
            )
        except OSError as exc:
            logger.warning("Cache write failed for %s: %s", agency_name, exc)

    def list_entries(self) -> list[dict]:
        if not self.cache_dir.exists():
            return []
        entries = []
        for path in sorted(self.cache_dir.glob("*.json")):
            try:
                data = json.loads(path.read_text())
                entries.append(
                    {
                        "agency": data.get("cache_key", path.stem),
                        "created": data.get("created_at", ""),
                        "expires": data.get("expires_at", ""),
                        "size_kb": round(path.stat().st_size / 1024, 1),
                    }
                )
            except (json.JSONDecodeError, OSError):
                continue
        return entries

    def clear(self, agency_name: str | None = None) -> int:
        if not self.cache_dir.exists():
            return 0
        if agency_name:
            path = self._cache_path(agency_name)
            if path.exists():
                path.unlink()
                return 1
            return 0
        count = 0
        for path in self.cache_dir.glob("*.json"):
            path.unlink()
            count += 1
        return count
