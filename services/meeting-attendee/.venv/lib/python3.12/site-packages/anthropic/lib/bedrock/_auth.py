from __future__ import annotations

from typing import TYPE_CHECKING

import httpx

from ..._utils import lru_cache

if TYPE_CHECKING:
    import boto3


@lru_cache(maxsize=512)
def _get_session(
    *,
    aws_access_key: str | None,
    aws_secret_key: str | None,
    aws_session_token: str | None,
    region: str | None,
    profile: str | None,
) -> boto3.Session:
    import boto3

    return boto3.Session(
        profile_name=profile,
        region_name=region,
        aws_access_key_id=aws_access_key,
        aws_secret_access_key=aws_secret_key,
        aws_session_token=aws_session_token,
    )


def get_auth_headers(
    *,
    method: str,
    url: str,
    headers: httpx.Headers,
    aws_access_key: str | None,
    aws_secret_key: str | None,
    aws_session_token: str | None,
    region: str | None,
    profile: str | None,
    data: str | None,
) -> dict[str, str]:
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    session = _get_session(
        profile=profile,
        region=region,
        aws_access_key=aws_access_key,
        aws_secret_key=aws_secret_key,
        aws_session_token=aws_session_token,
    )

    # The connection header may be stripped by a proxy somewhere, so the receiver
    # of this message may not see this header, so we remove it from the set of headers
    # that are signed.
    headers = headers.copy()
    del headers["connection"]

    request = AWSRequest(method=method.upper(), url=url, headers=headers, data=data)
    credentials = session.get_credentials()
    if not credentials:
        raise RuntimeError("could not resolve credentials from session")

    signer = SigV4Auth(credentials, "bedrock", session.region_name)
    signer.add_auth(request)

    prepped = request.prepare()

    return {key: value for key, value in dict(prepped.headers).items() if value is not None}
