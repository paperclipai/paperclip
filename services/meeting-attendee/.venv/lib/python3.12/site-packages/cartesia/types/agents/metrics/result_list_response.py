# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, List, Optional
from datetime import datetime
from typing_extensions import Literal

from pydantic import Field as FieldInfo

from ...._models import BaseModel
from ..agent_transcript import AgentTranscript

__all__ = ["ResultListResponse"]


class ResultListResponse(BaseModel):
    id: str
    """The unique identifier for the metric result."""

    agent_id: str = FieldInfo(alias="agentId")
    """The identifier of the agent associated with the metric result."""

    call_id: str = FieldInfo(alias="callId")
    """The identifier of the call associated with the metric result."""

    created_at: datetime = FieldInfo(alias="createdAt")
    """The UTC timestamp when the metric result was created."""

    deployment_id: str = FieldInfo(alias="deploymentId")
    """The identifier of the deployment associated with the metric result."""

    metric_id: str = FieldInfo(alias="metricId")
    """The identifier of the metric being measured."""

    metric_name: str = FieldInfo(alias="metricName")
    """The name of the metric being measured."""

    result: str
    """The raw result of the metric in a string format."""

    status: Literal["completed", "failed"]
    """The status of the metric result."""

    summary: str
    """A summary of the transcript of the call."""

    json_result: Optional[Dict[str, object]] = FieldInfo(alias="jsonResult", default=None)
    """The structured JSON result of the metric."""

    run_id: Optional[str] = FieldInfo(alias="runId", default=None)
    """The identifier of the run associated with the metric result, if applicable."""

    transcript: Optional[List[AgentTranscript]] = None
    """The transcript of the call."""

    value: Optional[object] = None
    """The value of the metric result."""
