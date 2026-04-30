from __future__ import annotations

import string
import sys
from typing import Dict
from urllib.error import HTTPError
from urllib.parse import quote as urlquote
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, urlopen
from urllib.response import addinfourl


def _make_redirect_request(request: Request, http_error: HTTPError) -> Request:
    """Create a new request object for a redirected request.

    The logic is based on [HTTPRedirectHandler](https://github.com/python/cpython/blob/b58bc8c2a9a316891a5ea1a0487aebfc86c2793a/Lib/urllib/request.py#L641-L751) from urllib.request.

    Args:
        request: The original request that resulted in the redirect.
        http_error: The response to the original request that indicates a
            redirect should occur and contains the new location.

    Returns:
        A new request object to the location indicated by the response.

    Raises:
        HTTPError: the supplied `http_error` if the redirect request
            cannot be created.
        ValueError: If the response code is None.
        ValueError: If the response does not contain a `Location` header
            or the `Location` header is not a string.
        HTTPError: If the scheme of the new location is not `http`,
            `https`, or `ftp`.
        HTTPError: If there are too many redirects or a redirect loop.
    """
    new_url = http_error.headers.get("Location")
    if new_url is None:
        raise http_error
    if not isinstance(new_url, str):
        raise ValueError(f"Location header {new_url!r} is not a string")

    new_url_parts = urlsplit(new_url)

    # For security reasons don't allow redirection to anything other than http,
    # https or ftp.
    if new_url_parts.scheme not in ("http", "https", "ftp", ""):
        raise HTTPError(
            new_url,
            http_error.code,
            f"{http_error.reason} - Redirection to url {new_url!r} is not allowed",
            http_error.headers,
            http_error.fp,
        )

    # http.client.parse_headers() decodes as ISO-8859-1.  Recover the original
    # bytes and percent-encode non-ASCII bytes, and any special characters such
    # as the space.
    new_url = urlquote(new_url, encoding="iso-8859-1", safe=string.punctuation)
    new_url = urljoin(request.full_url, new_url)

    # XXX Probably want to forget about the state of the current
    # request, although that might interact poorly with other
    # handlers that also use handler-specific request attributes
    content_headers = ("content-length", "content-type")
    newheaders = {
        k: v for k, v in request.headers.items() if k.lower() not in content_headers
    }
    new_request = Request(
        new_url,
        headers=newheaders,
        origin_req_host=request.origin_req_host,
        unverifiable=True,
    )

    visited: Dict[str, int]
    if hasattr(request, "redirect_dict"):
        visited = request.redirect_dict
        if (
            visited.get(new_url, 0) >= HTTPRedirectHandler.max_repeats
            or len(visited) >= HTTPRedirectHandler.max_redirections
        ):
            raise HTTPError(
                request.full_url,
                http_error.code,
                HTTPRedirectHandler.inf_msg + http_error.reason,
                http_error.headers,
                http_error.fp,
            )
    else:
        visited = {}
        setattr(request, "redirect_dict", visited)

    setattr(new_request, "redirect_dict", visited)
    visited[new_url] = visited.get(new_url, 0) + 1
    return new_request


def _urlopen(request: Request) -> addinfourl:
    """This is a shim for `urlopen` that handles HTTP redirects with status code
    308 (Permanent Redirect).

    This function should be removed once all supported versions of Python
    handles the 308 HTTP status code.

    Args:
        request: The request to open.

    Returns:
        The response to the request.
    """
    try:
        return urlopen(request)
    except HTTPError as error:
        if error.code == 308 and sys.version_info < (3, 11):
            # HTTP response code 308 (Permanent Redirect) is not supported by python
            # versions older than 3.11. See <https://bugs.python.org/issue40321> and
            # <https://github.com/python/cpython/issues/84501> for more details.
            # This custom error handling should be removed once all supported
            # versions of Python handles 308.
            new_request = _make_redirect_request(request, error)
            return _urlopen(new_request)
        else:
            raise
