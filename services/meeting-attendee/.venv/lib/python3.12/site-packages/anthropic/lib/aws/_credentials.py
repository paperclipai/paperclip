from __future__ import annotations

import os
from typing import Sequence


def validate_credentials(
    *,
    aws_access_key: str | None,
    aws_secret_key: str | None,
) -> None:
    """Raise if only one of aws_access_key/aws_secret_key is provided."""
    if (aws_access_key is not None) != (aws_secret_key is not None):
        provided = "aws_access_key" if aws_access_key is not None else "aws_secret_key"
        missing = "aws_secret_key" if aws_access_key is not None else "aws_access_key"
        raise ValueError(
            f"`{provided}` was provided without `{missing}`. "
            f"Both must be provided together, or neither (to use the default credential chain)."
        )


def _read_env(*env_vars: str) -> str | None:
    """Return the first non-None value from the given env vars, or None."""
    for var in env_vars:
        value = os.environ.get(var)
        if value is not None:
            return value
    return None


def resolve_auth_mode(
    *,
    api_key: str | None,
    aws_access_key: str | None,
    aws_secret_key: str | None,
    aws_profile: str | None,
    api_key_env_vars: Sequence[str] = ("ANTHROPIC_AWS_API_KEY",),
) -> bool:
    """Determine whether to use SigV4 auth. Returns True for SigV4, False for API key.

    Auth precedence:
    1. api_key constructor arg → API key mode
    2. aws_access_key + aws_secret_key constructor args → SigV4
    3. aws_profile constructor arg → SigV4
    4. API key env var(s) → API key mode (checked in order; first match wins)
    5. Default AWS credential chain → SigV4
    """
    if api_key is not None:
        return False

    if aws_access_key is not None or aws_secret_key is not None:
        return True

    if aws_profile is not None:
        return True

    # No explicit constructor args that signal SigV4 — check env vars
    if _read_env(*api_key_env_vars) is not None:
        return False

    # Fall back to default AWS credential chain
    return True


def resolve_api_key(
    *,
    api_key: str | None,
    use_sigv4: bool,
    api_key_env_vars: Sequence[str] = ("ANTHROPIC_AWS_API_KEY",),
) -> str | None:
    """Resolve the API key. Returns None if using SigV4."""
    if api_key is not None:
        return api_key

    if not use_sigv4:
        # Must be from env var
        return _read_env(*api_key_env_vars)

    return None


def resolve_region(aws_region: str | None) -> str | None:
    """Resolve the AWS region from constructor arg or env var.

    Does not silently default — returns None if no region is available.
    """
    if aws_region is not None:
        return aws_region

    return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")


def resolve_workspace_id(
    workspace_id: str | None,
    *,
    workspace_id_env_vars: Sequence[str] = ("ANTHROPIC_AWS_WORKSPACE_ID",),
) -> str | None:
    """Resolve the workspace ID from constructor arg or env var(s).

    Returns None if no workspace ID is available (caller should raise).
    """
    if workspace_id is not None:
        return workspace_id

    return _read_env(*workspace_id_env_vars)


def resolve_base_url(
    base_url: str | None,
    *,
    region: str | None,
    base_url_env_vars: Sequence[str] = ("ANTHROPIC_AWS_BASE_URL",),
    url_template: str = "https://aws-external-anthropic.{region}.api.aws",
) -> str | None:
    """Resolve the base URL from constructor arg, env var, or region.

    Returns None if no base URL is resolvable (caller should raise).
    """
    if base_url is not None:
        return base_url

    env_url = _read_env(*base_url_env_vars)
    if env_url is not None:
        return env_url

    if region is not None:
        return url_template.format(region=region)

    return None
