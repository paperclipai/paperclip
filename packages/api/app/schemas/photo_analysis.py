from datetime import datetime

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class AnalyzePhotosRequest(BaseModel):
    photo_urls: list[str] = Field(
        ..., min_length=1, max_length=50, description="URLs of listing photos to analyze"
    )


class PhotoLabelOverride(BaseModel):
    room_type: str | None = None
    condition: str | None = None
    damage_issues: list[str] | None = None
    renovation_needed: str | None = None


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class PhotoLabelResponse(BaseModel):
    id: str
    analysis_id: str
    photo_url: str
    photo_index: int
    room_type: str | None
    condition: str | None
    damage_issues: list[str] | None
    renovation_needed: str | None
    confidence: float
    confidence_tier: str
    review_status: str
    reviewer_override: dict | None

    model_config = {"from_attributes": True}


class PropertyPhotoAnalysisResponse(BaseModel):
    id: str
    property_id: str
    status: str
    photo_count: int
    model_id: str
    renovation_signal: str | None
    renovation_confidence: float | None
    total_cost_cents: int | None
    error_message: str | None
    created_at: datetime
    completed_at: datetime | None
    labels: list[PhotoLabelResponse] = []

    model_config = {"from_attributes": True}


class ReviewQueueItem(BaseModel):
    label: PhotoLabelResponse
    property_id: str
    property_address: str
    analysis_id: str


class ReviewQueueResponse(BaseModel):
    items: list[ReviewQueueItem]
    total: int
    page: int
    page_size: int
