from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from .._extras import google_auth

if TYPE_CHECKING:
    from google.auth.credentials import Credentials  # type: ignore[import-untyped]

# pyright: reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false
# google libraries don't provide types :/

# Note: these functions are blocking as they make HTTP requests, the async
# client runs these functions in a separate thread to ensure they do not
# cause synchronous blocking issues.


def load_auth(*, project_id: str | None) -> tuple[Credentials, str]:
    try:
        from google.auth.transport.requests import Request  # type: ignore[import-untyped]
    except ModuleNotFoundError as err:
        raise RuntimeError(
            f"Could not import google.auth, you need to install the SDK with `pip install anthropic[vertex]`"
        ) from err

    credentials, loaded_project_id = google_auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    credentials = cast(Any, credentials)
    credentials.refresh(Request())

    if not project_id:
        project_id = loaded_project_id

    if not project_id:
        raise ValueError("Could not resolve project_id")

    return credentials, project_id


def refresh_auth(credentials: Credentials) -> None:
    from google.auth.transport.requests import Request  # type: ignore[import-untyped]

    credentials.refresh(Request())
