"""HigherGov API client — fetch opportunity details and documents."""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)


class HigherGovClient:
    """Client for the HigherGov external API."""

    def __init__(self, api_key: str, base_url: str, doc_url: str) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.doc_url = doc_url.rstrip("/")
        self._client = httpx.Client(timeout=30)

    def get_opportunity(self, opp_key: str) -> dict | None:
        """Fetch opportunity metadata by opp_key."""
        resp = self._client.get(
            f"{self.base_url}/",
            params={"api_key": self.api_key, "opp_key": opp_key},
        )
        if resp.status_code != 200:
            logger.warning("HigherGov opportunity fetch failed: %d", resp.status_code)
            return None
        data = resp.json()
        results = data.get("results", [])
        return results[0] if results else None

    def get_documents(self, opp: dict) -> list[dict]:
        """Fetch document records for an opportunity.

        Uses the document_path from the opportunity record, or constructs
        the URL from the related_key.
        """
        doc_path = opp.get("document_path", "")
        if doc_path:
            resp = self._client.get(doc_path)
        else:
            # Fallback: construct from source_id
            source_id = opp.get("source_id", "")
            agency_key = opp.get("agency_key", "")
            if not source_id:
                return []
            related_key = f"{agency_key}-{source_id}" if agency_key else source_id
            resp = self._client.get(
                f"{self.doc_url}/",
                params={
                    "api_key": self.api_key,
                    "related_key": related_key,
                    "page_size": 50,
                },
            )

        if resp.status_code != 200:
            logger.warning("HigherGov document fetch failed: %d", resp.status_code)
            return []

        data = resp.json()
        return data.get("results", [])

    def download_document(self, doc: dict, dest_dir: Path) -> Path | None:
        """Download a document to dest_dir. Returns the saved file path."""
        url = doc.get("download_url", "")
        name = doc.get("file_name", "document.pdf")
        if not url:
            logger.warning("No download_url for document: %s", name)
            return None

        dest = dest_dir / name
        if dest.exists():
            logger.info("Document already exists: %s", dest)
            return dest

        try:
            resp = self._client.get(url, follow_redirects=True)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
            logger.info("Downloaded %s (%d KB)", name, len(resp.content) // 1024)
            return dest
        except Exception as exc:
            logger.warning("Failed to download %s: %s", name, exc)
            return None

    def get_full_text(self, opp_key: str) -> tuple[str, dict, list[dict]]:
        """Convenience: fetch opportunity + documents, return combined text.

        Returns (combined_text, opportunity_dict, document_records).
        The combined_text includes the AI summary, description, and all
        document text_extract fields — ready to feed into RFPContext.raw_text.
        """
        opp = self.get_opportunity(opp_key)
        if not opp:
            return "", {}, []

        parts = []

        # Opportunity-level text
        ai_summary = opp.get("ai_summary", "") or ""
        description = opp.get("description_text", "") or ""
        if ai_summary:
            parts.append(f"## HigherGov AI Summary\n{ai_summary}")
        if description:
            parts.append(f"## Opportunity Description\n{description}")

        # Document text extracts
        docs = self.get_documents(opp)
        for doc in docs:
            text = doc.get("text_extract", "") or ""
            if text:
                fname = doc.get("file_name", "unknown")
                parts.append(f"## Document: {fname}\n{text}")

        combined = "\n\n".join(parts)
        return combined, opp, docs

    def close(self) -> None:
        self._client.close()
