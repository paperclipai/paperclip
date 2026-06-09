"""Tests for the Claude Vision integration service."""

from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.claude_vision import (
    HIGH_CONFIDENCE_THRESHOLD,
    LOW_CONFIDENCE_THRESHOLD,
    ClaudeVisionService,
    PhotoAnalysisResult,
    _aggregate_renovation_signal,
    _confidence_tier,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FAKE_API_KEY = "sk-ant-test-key"


def _make_anthropic_response(
    room_type: str = "kitchen",
    condition: str = "fair",
    damage_issues: list[str] | None = None,
    renovation_needed: str = "moderate",
    confidence: float = 0.85,
    input_tokens: int = 500,
    output_tokens: int = 100,
) -> dict:
    content_text = json.dumps(
        {
            "room_type": room_type,
            "condition": condition,
            "damage_issues": damage_issues or [],
            "renovation_needed": renovation_needed,
            "confidence": confidence,
        }
    )
    return {
        "content": [{"type": "text", "text": content_text}],
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
    }


# ---------------------------------------------------------------------------
# Confidence tier tests
# ---------------------------------------------------------------------------


class TestConfidenceTier:
    def test_high_confidence(self):
        assert _confidence_tier(0.9) == "high"
        assert _confidence_tier(HIGH_CONFIDENCE_THRESHOLD) == "high"

    def test_medium_confidence(self):
        assert _confidence_tier(0.65) == "medium"
        assert _confidence_tier(LOW_CONFIDENCE_THRESHOLD) == "medium"

    def test_low_confidence(self):
        assert _confidence_tier(0.3) == "low"
        assert _confidence_tier(0.0) == "low"

    def test_boundary_high(self):
        assert _confidence_tier(0.80) == "high"
        assert _confidence_tier(0.79) == "medium"

    def test_boundary_low(self):
        assert _confidence_tier(0.50) == "medium"
        assert _confidence_tier(0.49) == "low"


# ---------------------------------------------------------------------------
# Renovation signal aggregation tests
# ---------------------------------------------------------------------------


class TestAggregateRenovationSignal:
    def test_empty_labels(self):
        signal, confidence = _aggregate_renovation_signal([])
        assert signal == "none"
        assert confidence == 0.0

    def test_single_none_renovation(self):
        labels = [
            PhotoAnalysisResult(
                photo_url="http://example.com/1.jpg",
                photo_index=0,
                room_type="kitchen",
                condition="excellent",
                damage_issues=[],
                renovation_needed="none",
                confidence=0.95,
                confidence_tier="high",
                raw_response=None,
            )
        ]
        signal, confidence = _aggregate_renovation_signal(labels)
        assert signal == "none"

    def test_single_major_renovation(self):
        labels = [
            PhotoAnalysisResult(
                photo_url="http://example.com/1.jpg",
                photo_index=0,
                room_type="bathroom",
                condition="poor",
                damage_issues=["water_damage"],
                renovation_needed="major",
                confidence=0.9,
                confidence_tier="high",
                raw_response=None,
            )
        ]
        signal, _ = _aggregate_renovation_signal(labels)
        assert signal == "high"

    def test_mixed_renovation_levels(self):
        labels = [
            PhotoAnalysisResult(
                photo_url="http://example.com/1.jpg",
                photo_index=0,
                room_type="kitchen",
                condition="fair",
                damage_issues=[],
                renovation_needed="cosmetic",
                confidence=0.8,
                confidence_tier="high",
                raw_response=None,
            ),
            PhotoAnalysisResult(
                photo_url="http://example.com/2.jpg",
                photo_index=1,
                room_type="bathroom",
                condition="poor",
                damage_issues=["mold"],
                renovation_needed="major",
                confidence=0.9,
                confidence_tier="high",
                raw_response=None,
            ),
        ]
        signal, _ = _aggregate_renovation_signal(labels)
        # weighted avg: (1*0.8 + 3*0.9) / (0.8+0.9) = 3.5/1.7 ≈ 2.06 → "moderate"
        assert signal == "moderate"

    def test_all_full_gut(self):
        labels = [
            PhotoAnalysisResult(
                photo_url=f"http://example.com/{i}.jpg",
                photo_index=i,
                room_type="bedroom",
                condition="critical",
                damage_issues=["structural_concern"],
                renovation_needed="full_gut",
                confidence=0.95,
                confidence_tier="high",
                raw_response=None,
            )
            for i in range(3)
        ]
        signal, _ = _aggregate_renovation_signal(labels)
        assert signal == "critical"

    def test_confidence_weighting(self):
        # High confidence "major" vs low confidence "none" → should lean toward major
        labels = [
            PhotoAnalysisResult(
                photo_url="http://example.com/1.jpg",
                photo_index=0,
                room_type="kitchen",
                condition="poor",
                damage_issues=[],
                renovation_needed="major",
                confidence=0.95,
                confidence_tier="high",
                raw_response=None,
            ),
            PhotoAnalysisResult(
                photo_url="http://example.com/2.jpg",
                photo_index=1,
                room_type="exterior",
                condition="excellent",
                damage_issues=[],
                renovation_needed="none",
                confidence=0.2,
                confidence_tier="low",
                raw_response=None,
            ),
        ]
        signal, _ = _aggregate_renovation_signal(labels)
        # weighted avg: (3*0.95 + 0*0.2) / (0.95+0.2) = 2.85/1.15 ≈ 2.48 → "moderate"
        assert signal in ("moderate", "high")

    def test_none_renovation_needed_value(self):
        labels = [
            PhotoAnalysisResult(
                photo_url="http://example.com/1.jpg",
                photo_index=0,
                room_type="kitchen",
                condition="good",
                damage_issues=[],
                renovation_needed=None,
                confidence=0.8,
                confidence_tier="high",
                raw_response=None,
            )
        ]
        signal, _ = _aggregate_renovation_signal(labels)
        assert signal == "none"


# ---------------------------------------------------------------------------
# ClaudeVisionService tests
# ---------------------------------------------------------------------------


class TestClaudeVisionService:
    @pytest.mark.asyncio
    async def test_analyze_single_photo_success(self):
        service = ClaudeVisionService(api_key=FAKE_API_KEY)
        response_data = _make_anthropic_response()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = response_data
        mock_response.raise_for_status = MagicMock()

        with patch("app.services.claude_vision.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post.return_value = mock_response
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            result = await service._analyze_single_photo("http://example.com/photo.jpg", 0)

        assert result.room_type == "kitchen"
        assert result.condition == "fair"
        assert result.renovation_needed == "moderate"
        assert result.confidence == 0.85
        assert result.confidence_tier == "high"
        assert result.photo_index == 0

    @pytest.mark.asyncio
    async def test_analyze_property_photos_batch(self):
        service = ClaudeVisionService(api_key=FAKE_API_KEY)

        responses = [
            _make_anthropic_response(room_type="kitchen", confidence=0.9),
            _make_anthropic_response(room_type="bathroom", condition="poor", confidence=0.85),
            _make_anthropic_response(room_type="bedroom", confidence=0.7),
        ]
        call_count = 0

        def make_response():
            nonlocal call_count
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = responses[call_count % len(responses)]
            resp.raise_for_status = MagicMock()
            call_count += 1
            return resp

        with patch("app.services.claude_vision.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(side_effect=lambda *a, **kw: make_response())
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            summary = await service.analyze_property_photos(
                ["http://ex.com/1.jpg", "http://ex.com/2.jpg", "http://ex.com/3.jpg"]
            )

        assert len(summary.labels) == 3
        assert summary.renovation_signal in ("none", "low", "moderate", "high", "critical")
        assert summary.renovation_confidence >= 0.0

    @pytest.mark.asyncio
    async def test_analyze_photo_rate_limit_retry(self):
        service = ClaudeVisionService(api_key=FAKE_API_KEY, max_concurrent=1)

        rate_limit_resp = MagicMock()
        rate_limit_resp.status_code = 429
        rate_limit_resp.raise_for_status = MagicMock()

        success_resp = MagicMock()
        success_resp.status_code = 200
        success_resp.json.return_value = _make_anthropic_response()
        success_resp.raise_for_status = MagicMock()

        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return rate_limit_resp
            return success_resp

        with patch("app.services.claude_vision.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(side_effect=side_effect)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.services.claude_vision.asyncio.sleep", new_callable=AsyncMock):
                result = await service._analyze_single_photo("http://ex.com/1.jpg", 0)

        assert result.room_type == "kitchen"
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_analyze_photo_all_retries_exhausted(self):
        service = ClaudeVisionService(api_key=FAKE_API_KEY, max_concurrent=1)

        error_resp = MagicMock()
        error_resp.status_code = 500
        error_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Server Error", request=MagicMock(), response=error_resp
        )

        with patch("app.services.claude_vision.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post.return_value = error_resp
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.services.claude_vision.asyncio.sleep", new_callable=AsyncMock):
                with pytest.raises(RuntimeError, match="Failed to analyze photo"):
                    await service._analyze_single_photo("http://ex.com/1.jpg", 0)

    @pytest.mark.asyncio
    async def test_analyze_photo_invalid_json_response(self):
        service = ClaudeVisionService(api_key=FAKE_API_KEY, max_concurrent=1)

        bad_resp = MagicMock()
        bad_resp.status_code = 200
        bad_resp.json.return_value = {
            "content": [{"type": "text", "text": "not valid json {"}],
            "usage": {"input_tokens": 100, "output_tokens": 50},
        }
        bad_resp.raise_for_status = MagicMock()

        with patch("app.services.claude_vision.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post.return_value = bad_resp
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.services.claude_vision.asyncio.sleep", new_callable=AsyncMock):
                with pytest.raises(RuntimeError, match="Failed to analyze photo"):
                    await service._analyze_single_photo("http://ex.com/1.jpg", 0)

    @pytest.mark.asyncio
    async def test_failed_photo_returns_low_confidence_in_batch(self):
        service = ClaudeVisionService(api_key=FAKE_API_KEY, max_concurrent=1)

        error_resp = MagicMock()
        error_resp.status_code = 500
        error_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Error", request=MagicMock(), response=error_resp
        )

        success_resp = MagicMock()
        success_resp.status_code = 200
        success_resp.json.return_value = _make_anthropic_response()
        success_resp.raise_for_status = MagicMock()

        call_idx = 0

        def side_effect(*args, **kwargs):
            nonlocal call_idx
            call_idx += 1
            # First 3 calls fail (retries for photo 0), then succeed for photo 1
            if call_idx <= 3:
                return error_resp
            return success_resp

        with patch("app.services.claude_vision.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(side_effect=side_effect)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.services.claude_vision.asyncio.sleep", new_callable=AsyncMock):
                summary = await service.analyze_property_photos(
                    ["http://ex.com/fail.jpg", "http://ex.com/ok.jpg"]
                )

        assert len(summary.labels) == 2
        # Failed photo should have 0 confidence and low tier
        failed = summary.labels[0]
        assert failed.confidence == 0.0
        assert failed.confidence_tier == "low"
        assert "error" in (failed.raw_response or {})

        # Successful photo
        success = summary.labels[1]
        assert success.room_type == "kitchen"

    @pytest.mark.asyncio
    async def test_token_tracking(self):
        service = ClaudeVisionService(api_key=FAKE_API_KEY)

        resp_data = _make_anthropic_response(input_tokens=1000, output_tokens=200)
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = resp_data
        mock_resp.raise_for_status = MagicMock()

        with patch("app.services.claude_vision.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post.return_value = mock_resp
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            summary = await service.analyze_property_photos(["http://ex.com/1.jpg"])

        assert summary.total_input_tokens == 1000
        assert summary.total_output_tokens == 200


# ---------------------------------------------------------------------------
# Integration-style tests (API endpoints via test client)
# ---------------------------------------------------------------------------


class TestPhotoAnalysisEndpoints:
    @pytest.mark.asyncio
    async def test_analyze_photos_property_not_found(self, client):
        resp = await client.post(
            f"/properties/{uuid.uuid4()}/analyze-photos",
            json={"photo_urls": ["http://example.com/1.jpg"]},
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_analyze_photos_empty_urls(self, client):
        resp = await client.post(
            f"/properties/{uuid.uuid4()}/analyze-photos",
            json={"photo_urls": []},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_get_photo_analysis_property_not_found(self, client):
        resp = await client.get(f"/properties/{uuid.uuid4()}/photo-analysis")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_override_label_not_found(self, client):
        resp = await client.patch(
            f"/photo-labels/{uuid.uuid4()}",
            json={"room_type": "bathroom"},
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_review_queue_empty(self, client):
        resp = await client.get("/review-queue")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []

    @pytest.mark.asyncio
    async def test_analyze_photos_success(self, client, db_session):
        from app.models import Property, Tenant
        from tests.conftest import TENANT_ID

        # Create tenant and property
        tenant = Tenant(id=TENANT_ID, name="Test", slug="test")
        db_session.add(tenant)
        await db_session.flush()

        prop = Property(
            tenant_id=TENANT_ID,
            address="123 Main St",
            city="Austin",
            state="TX",
            zip="78701",
        )
        db_session.add(prop)
        await db_session.flush()

        # Mock the Claude Vision service
        mock_summary_data = _make_anthropic_response(
            room_type="kitchen", condition="fair", confidence=0.85
        )

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = mock_summary_data
        mock_resp.raise_for_status = MagicMock()

        with patch("app.routers.photo_analysis.ClaudeVisionService") as mock_cls:
            from app.services.claude_vision import PhotoAnalysisResult, PropertyAnalysisSummary

            mock_service = AsyncMock()
            mock_service._model = "claude-sonnet-4-6-20250514"
            mock_service.analyze_property_photos.return_value = PropertyAnalysisSummary(
                labels=[
                    PhotoAnalysisResult(
                        photo_url="http://ex.com/1.jpg",
                        photo_index=0,
                        room_type="kitchen",
                        condition="fair",
                        damage_issues=["peeling_paint"],
                        renovation_needed="moderate",
                        confidence=0.85,
                        confidence_tier="high",
                        raw_response={"room_type": "kitchen"},
                    ),
                ],
                renovation_signal="moderate",
                renovation_confidence=0.85,
                total_input_tokens=500,
                total_output_tokens=100,
            )
            mock_cls.return_value = mock_service

            resp = await client.post(
                f"/properties/{prop.id}/analyze-photos",
                json={"photo_urls": ["http://ex.com/1.jpg"]},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert data["renovation_signal"] == "moderate"
        assert len(data["labels"]) == 1
        assert data["labels"][0]["room_type"] == "kitchen"
        assert data["labels"][0]["confidence_tier"] == "high"
        assert data["labels"][0]["review_status"] == "auto_accepted"

    @pytest.mark.asyncio
    async def test_analyze_photos_low_confidence_flagged(self, client, db_session):
        from app.models import Property, Tenant
        from tests.conftest import TENANT_ID

        tenant = Tenant(id=TENANT_ID, name="Test", slug="test")
        db_session.add(tenant)
        await db_session.flush()

        prop = Property(
            tenant_id=TENANT_ID,
            address="456 Oak Ave",
            city="Austin",
            state="TX",
            zip="78702",
        )
        db_session.add(prop)
        await db_session.flush()

        with patch("app.routers.photo_analysis.ClaudeVisionService") as mock_cls:
            from app.services.claude_vision import PhotoAnalysisResult, PropertyAnalysisSummary

            mock_service = AsyncMock()
            mock_service._model = "claude-sonnet-4-6-20250514"
            mock_service.analyze_property_photos.return_value = PropertyAnalysisSummary(
                labels=[
                    PhotoAnalysisResult(
                        photo_url="http://ex.com/blurry.jpg",
                        photo_index=0,
                        room_type=None,
                        condition=None,
                        damage_issues=[],
                        renovation_needed=None,
                        confidence=0.3,
                        confidence_tier="low",
                        raw_response={"confidence": 0.3},
                    ),
                ],
                renovation_signal="none",
                renovation_confidence=0.3,
                total_input_tokens=300,
                total_output_tokens=50,
            )
            mock_cls.return_value = mock_service

            resp = await client.post(
                f"/properties/{prop.id}/analyze-photos",
                json={"photo_urls": ["http://ex.com/blurry.jpg"]},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["labels"][0]["review_status"] == "pending_review"
        assert data["labels"][0]["confidence_tier"] == "low"

        # Verify it shows up in review queue
        queue_resp = await client.get("/review-queue")
        assert queue_resp.status_code == 200
        queue_data = queue_resp.json()
        assert queue_data["total"] == 1
        assert queue_data["items"][0]["property_address"] == "456 Oak Ave"

    @pytest.mark.asyncio
    async def test_override_label_success(self, client, db_session):
        from app.models import PhotoLabel, Property, PropertyPhotoAnalysis, Tenant
        from tests.conftest import TENANT_ID

        tenant = Tenant(id=TENANT_ID, name="Test", slug="test")
        db_session.add(tenant)
        await db_session.flush()

        prop = Property(
            tenant_id=TENANT_ID,
            address="789 Pine St",
            city="Austin",
            state="TX",
            zip="78703",
        )
        db_session.add(prop)
        await db_session.flush()

        analysis = PropertyPhotoAnalysis(
            property_id=prop.id,
            status="completed",
            photo_count=1,
            model_id="claude-sonnet-4-6-20250514",
        )
        db_session.add(analysis)
        await db_session.flush()

        label = PhotoLabel(
            analysis_id=analysis.id,
            photo_url="http://ex.com/1.jpg",
            photo_index=0,
            room_type=None,
            condition=None,
            damage_issues=[],
            renovation_needed=None,
            confidence=0.3,
            confidence_tier="low",
            review_status="pending_review",
        )
        db_session.add(label)
        await db_session.flush()

        resp = await client.patch(
            f"/photo-labels/{label.id}",
            json={"room_type": "bathroom", "condition": "poor", "renovation_needed": "major"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["room_type"] == "bathroom"
        assert data["condition"] == "poor"
        assert data["renovation_needed"] == "major"
        assert data["review_status"] == "reviewed"
        assert data["reviewer_override"]["room_type"] == "bathroom"

    @pytest.mark.asyncio
    async def test_get_photo_analysis_returns_results(self, client, db_session):
        from app.models import PhotoLabel, Property, PropertyPhotoAnalysis, Tenant
        from tests.conftest import TENANT_ID

        tenant = Tenant(id=TENANT_ID, name="Test", slug="test")
        db_session.add(tenant)
        await db_session.flush()

        prop = Property(
            tenant_id=TENANT_ID,
            address="101 Elm St",
            city="Austin",
            state="TX",
            zip="78704",
        )
        db_session.add(prop)
        await db_session.flush()

        analysis = PropertyPhotoAnalysis(
            property_id=prop.id,
            status="completed",
            photo_count=1,
            model_id="claude-sonnet-4-6-20250514",
            renovation_signal="moderate",
            renovation_confidence=0.85,
        )
        db_session.add(analysis)
        await db_session.flush()

        label = PhotoLabel(
            analysis_id=analysis.id,
            photo_url="http://ex.com/1.jpg",
            photo_index=0,
            room_type="kitchen",
            condition="fair",
            damage_issues=["peeling_paint"],
            renovation_needed="moderate",
            confidence=0.85,
            confidence_tier="high",
            review_status="auto_accepted",
        )
        db_session.add(label)
        await db_session.flush()

        resp = await client.get(f"/properties/{prop.id}/photo-analysis")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["status"] == "completed"
        assert data[0]["renovation_signal"] == "moderate"
        assert len(data[0]["labels"]) == 1
