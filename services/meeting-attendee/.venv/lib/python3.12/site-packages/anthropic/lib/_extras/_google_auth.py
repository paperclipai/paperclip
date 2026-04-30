from __future__ import annotations

from typing import TYPE_CHECKING, Any
from typing_extensions import ClassVar, override

from ._common import MissingDependencyError
from ..._utils import LazyProxy

if TYPE_CHECKING:
    import google.auth  # type: ignore

    google_auth = google.auth


class GoogleAuthProxy(LazyProxy[Any]):
    should_cache: ClassVar[bool] = True

    @override
    def __load__(self) -> Any:
        try:
            import google.auth  # type: ignore
        except ImportError as err:
            raise MissingDependencyError(extra="vertex", library="google-auth") from err

        return google.auth


if not TYPE_CHECKING:
    google_auth = GoogleAuthProxy()
