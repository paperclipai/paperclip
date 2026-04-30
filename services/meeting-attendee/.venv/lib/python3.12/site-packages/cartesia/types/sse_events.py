# SSE Event types for Server-Sent Events streaming

import base64
from typing import List, Union, Optional
from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["SSEEvent", "ChunkEvent", "TimestampsEvent", "PhonemeTimestampsEvent", "DoneEvent", "ErrorEvent", "WordTimestamps", "PhonemeTimestamps"]


class SSEEvent(BaseModel):
    """Base class for Server-Sent Events.

    Subclasses each define their own ``type`` field as a ``Literal``,
    which lets pyright narrow the ``SSEEventType`` union via
    ``event.type == "chunk"`` etc.
    """

    id: Optional[str] = None
    """Optional event ID for reconnection support"""

    retry: Optional[int] = None
    """Optional retry timeout in milliseconds"""


class WordTimestamps(BaseModel):
    """Word-level timestamps"""
    words: List[str]
    start: List[float]
    end: List[float]


class PhonemeTimestamps(BaseModel):
    """Phoneme-level timestamps"""
    phonemes: List[str]
    start: List[float]
    end: List[float]


class ChunkEvent(SSEEvent):
    """Audio chunk event with decoded audio data"""

    type: Literal["chunk"] = "chunk"

    data: str
    """Base64-encoded audio data"""

    context_id: Optional[str] = None
    """Context ID for request correlation"""

    status_code: Optional[int] = None
    """HTTP status code"""

    step_time: Optional[float] = None
    """Time taken to generate this chunk"""

    done: bool = False
    """Whether this is the final chunk"""

    @property
    def audio(self) -> Optional[bytes]:
        """
        Decoded audio data as bytes.

        This property automatically base64-decodes the data field for convenience.
        Returns None if data is None or empty.
        """
        if not self.data:
            return None
        try:
            return base64.b64decode(self.data)
        except Exception:
            return None


class TimestampsEvent(SSEEvent):
    """Word-level timestamp event"""

    type: Literal["timestamps"] = "timestamps"

    word_timestamps: Optional[WordTimestamps] = None
    """Word-level timestamp object"""

    context_id: Optional[str] = None
    """Context ID for request correlation"""

    @property
    def timestamps(self) -> Optional[WordTimestamps]:
        """Alias for word_timestamps for convenience"""
        return self.word_timestamps


class PhonemeTimestampsEvent(SSEEvent):
    """Phoneme-level timestamp event"""

    type: Literal["phoneme_timestamps"] = "phoneme_timestamps"

    phoneme_timestamps: Optional[PhonemeTimestamps] = None
    """Phoneme-level timestamp object"""

    context_id: Optional[str] = None
    """Context ID for request correlation"""

    @property
    def timestamps(self) -> Optional[PhonemeTimestamps]:
        """Alias for phoneme_timestamps for convenience"""
        return self.phoneme_timestamps


class DoneEvent(SSEEvent):
    """Stream completion event"""

    type: Literal["done"] = "done"

    context_id: Optional[str] = None
    """Context ID for request correlation"""

    status_code: Optional[int] = None
    """HTTP status code"""


class ErrorEvent(SSEEvent):
    """Stream error event"""

    type: Literal["error"] = "error"

    error: Optional[str] = None
    """Error message"""

    context_id: Optional[str] = None
    """Context ID for request correlation"""

    status_code: Optional[int] = None
    """HTTP status code"""


# Union type for all possible SSE events
SSEEventType = Union[ChunkEvent, TimestampsEvent, PhonemeTimestampsEvent, DoneEvent, ErrorEvent]
