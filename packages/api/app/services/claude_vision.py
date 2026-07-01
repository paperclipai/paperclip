"""Claude Vision integration service for listing photo analysis.

Wraps the Anthropic API to analyze property listing photos for renovation
assessment. Extracts room types, conditions, damage/issues, and computes
confidence scores per photo.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-6-20250514"
MAX_CONCURRENT_REQUESTS = 5
MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 2.0

ANALYSIS_PROMPT = """\
You are a real estate renovation assessment expert. Analyze this listing photo and provide a structured assessment.

For this photo, determine:
1. **room_type**: The type of room/area shown (e.g., kitchen, bathroom, bedroom, living_room, basement, exterior, garage, attic, hallway, dining_room, laundry, yard, roof, other)
2. **condition**: Overall condition assessment (excellent, good, fair, poor, critical)
3. **damage_issues**: List any visible damage or issues (e.g., water_damage, mold, cracked_walls, peeling_paint, damaged_flooring, outdated_fixtures, structural_concern, roof_damage, foundation_issue). Empty list if none visible.
4. **renovation_needed**: Level of renovation needed (none, cosmetic, moderate, major, full_gut)
5. **confidence**: Your confidence in this assessment from 0.0 to 1.0

Respond ONLY with valid JSON in this exact format:
{
  "room_type": "kitchen",
  "condition": "fair",
  "damage_issues": ["peeling_paint", "outdated_fixtures"],
  "renovation_needed": "moderate",
  "confidence": 0.85
}
"""

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class PhotoAnalysisResult:
    photo_url: str
    photo_index: int
    room_type: str | None
    condition: str | None
    damage_issues: list[str]
    renovation_needed: str | None
    confidence: float
    confidence_tier: str  # high, medium, low
    raw_response: dict[str, Any] | None


@dataclass
class PropertyAnalysisSummary:
    labels: list[PhotoAnalysisResult]
    renovation_signal: str  # none, low, moderate, high, critical
    renovation_confidence: float
    total_input_tokens: int
    total_output_tokens: int


# ---------------------------------------------------------------------------
# Confidence tier thresholds (configurable per label type in future)
# ---------------------------------------------------------------------------

HIGH_CONFIDENCE_THRESHOLD = 0.80
LOW_CONFIDENCE_THRESHOLD = 0.50


def _confidence_tier(score: float) -> str:
    if score >= HIGH_CONFIDENCE_THRESHOLD:
        return "high"
    if score >= LOW_CONFIDENCE_THRESHOLD:
        return "medium"
    return "low"


# ---------------------------------------------------------------------------
# Renovation signal aggregation
# ---------------------------------------------------------------------------

_RENOVATION_WEIGHT = {
    "none": 0,
    "cosmetic": 1,
    "moderate": 2,
    "major": 3,
    "full_gut": 4,
}

_SIGNAL_THRESHOLDS = [
    (0.0, "none"),
    (0.5, "low"),
    (1.5, "moderate"),
    (2.5, "high"),
    (3.5, "critical"),
]


def _aggregate_renovation_signal(
    labels: list[PhotoAnalysisResult],
) -> tuple[str, float]:
    """Compute property-level renovation signal from per-photo labels."""
    if not labels:
        return "none", 0.0

    weighted_sum = 0.0
    weight_total = 0.0
    for label in labels:
        w = label.confidence
        score = _RENOVATION_WEIGHT.get(label.renovation_needed or "none", 0)
        weighted_sum += score * w
        weight_total += w

    if weight_total == 0:
        return "none", 0.0

    avg = weighted_sum / weight_total
    signal = "none"
    for threshold, name in _SIGNAL_THRESHOLDS:
        if avg >= threshold:
            signal = name

    avg_confidence = weight_total / len(labels)
    return signal, round(avg_confidence, 3)


# ---------------------------------------------------------------------------
# Claude Vision Service
# ---------------------------------------------------------------------------


class ClaudeVisionService:
    """Async service wrapping the Anthropic Messages API for image analysis."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str = DEFAULT_MODEL,
        max_concurrent: int = MAX_CONCURRENT_REQUESTS,
    ) -> None:
        self._api_key = api_key or settings.ANTHROPIC_API_KEY
        self._model = model
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._total_input_tokens = 0
        self._total_output_tokens = 0

    async def analyze_property_photos(
        self, photo_urls: list[str]
    ) -> PropertyAnalysisSummary:
        """Analyze all photos for a property in one batch."""
        self._total_input_tokens = 0
        self._total_output_tokens = 0

        tasks = [
            self._analyze_single_photo(url, idx)
            for idx, url in enumerate(photo_urls)
        ]
        labels = await asyncio.gather(*tasks, return_exceptions=True)

        results: list[PhotoAnalysisResult] = []
        for i, result in enumerate(labels):
            if isinstance(result, Exception):
                logger.error("Photo %d analysis failed: %s", i, result)
                results.append(
                    PhotoAnalysisResult(
                        photo_url=photo_urls[i],
                        photo_index=i,
                        room_type=None,
                        condition=None,
                        damage_issues=[],
                        renovation_needed=None,
                        confidence=0.0,
                        confidence_tier="low",
                        raw_response={"error": str(result)},
                    )
                )
            else:
                results.append(result)

        signal, confidence = _aggregate_renovation_signal(results)

        return PropertyAnalysisSummary(
            labels=results,
            renovation_signal=signal,
            renovation_confidence=confidence,
            total_input_tokens=self._total_input_tokens,
            total_output_tokens=self._total_output_tokens,
        )

    async def _analyze_single_photo(
        self, photo_url: str, index: int
    ) -> PhotoAnalysisResult:
        """Analyze a single photo with rate limiting and retries."""
        async with self._semaphore:
            return await self._call_claude_vision(photo_url, index)

    async def _call_claude_vision(
        self, photo_url: str, index: int
    ) -> PhotoAnalysisResult:
        """Make the actual API call to Claude with retry logic."""
        import json

        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES):
            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    response = await client.post(
                        "https://api.anthropic.com/v1/messages",
                        headers={
                            "x-api-key": self._api_key,
                            "anthropic-version": "2023-06-01",
                            "content-type": "application/json",
                        },
                        json={
                            "model": self._model,
                            "max_tokens": 512,
                            "messages": [
                                {
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "image",
                                            "source": {
                                                "type": "url",
                                                "url": photo_url,
                                            },
                                        },
                                        {
                                            "type": "text",
                                            "text": ANALYSIS_PROMPT,
                                        },
                                    ],
                                }
                            ],
                        },
                    )

                if response.status_code == 429:
                    wait = RETRY_BACKOFF_BASE ** (attempt + 1)
                    logger.warning(
                        "Rate limited on photo %d, retrying in %.1fs", index, wait
                    )
                    await asyncio.sleep(wait)
                    continue

                response.raise_for_status()
                data = response.json()

                self._total_input_tokens += data.get("usage", {}).get(
                    "input_tokens", 0
                )
                self._total_output_tokens += data.get("usage", {}).get(
                    "output_tokens", 0
                )

                text = data["content"][0]["text"]
                parsed = json.loads(text)

                confidence = float(parsed.get("confidence", 0.0))
                return PhotoAnalysisResult(
                    photo_url=photo_url,
                    photo_index=index,
                    room_type=parsed.get("room_type"),
                    condition=parsed.get("condition"),
                    damage_issues=parsed.get("damage_issues", []),
                    renovation_needed=parsed.get("renovation_needed"),
                    confidence=confidence,
                    confidence_tier=_confidence_tier(confidence),
                    raw_response=parsed,
                )

            except (httpx.HTTPStatusError, json.JSONDecodeError, KeyError) as exc:
                last_error = exc
                if attempt < MAX_RETRIES - 1:
                    wait = RETRY_BACKOFF_BASE ** (attempt + 1)
                    logger.warning(
                        "Photo %d attempt %d failed: %s, retrying in %.1fs",
                        index,
                        attempt + 1,
                        exc,
                        wait,
                    )
                    await asyncio.sleep(wait)

        raise RuntimeError(
            f"Failed to analyze photo {index} after {MAX_RETRIES} attempts: {last_error}"
        )
