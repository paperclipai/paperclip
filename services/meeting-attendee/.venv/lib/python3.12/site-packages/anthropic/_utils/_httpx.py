"""
This file includes code adapted from HTTPX's utility module
(https://github.com/encode/httpx/blob/336204f0121a9aefdebac5cacd81f912bafe8057/httpx/_utils.py).
We implement custom proxy handling to support configurations like `socket_options`,
which are not currently configurable through the HTTPX client.
For more context, see: https://github.com/encode/httpx/discussions/3514
"""

from __future__ import annotations

import ipaddress
from typing import Mapping
from urllib.request import getproxies


def is_ipv4_hostname(hostname: str) -> bool:
    try:
        ipaddress.IPv4Address(hostname.split("/")[0])
    except Exception:
        return False
    return True


def is_ipv6_hostname(hostname: str) -> bool:
    try:
        ipaddress.IPv6Address(hostname.split("/")[0])
    except Exception:
        return False
    return True


def get_environment_proxies() -> Mapping[str, str | None]:
    """
    Gets the proxy mappings based on environment variables.
    We use our own logic to parse these variables, as HTTPX
    doesn’t allow full configuration of the underlying
    transport when proxies are set via environment variables.
    """

    proxy_info = getproxies()
    mounts: dict[str, str | None] = {}

    for scheme in ("http", "https", "all"):
        if proxy_info.get(scheme):
            hostname = proxy_info[scheme]
            mounts[f"{scheme}://"] = hostname if "://" in hostname else f"http://{hostname}"

    no_proxy_hosts = [host.strip() for host in proxy_info.get("no", "").split(",")]
    for hostname in no_proxy_hosts:
        if hostname == "*":
            return {}
        elif hostname:
            if "://" in hostname:
                mounts[hostname] = None
            elif is_ipv4_hostname(hostname):
                mounts[f"all://{hostname}"] = None
            elif is_ipv6_hostname(hostname):
                mounts[f"all://[{hostname}]"] = None
            elif hostname.lower() == "localhost":
                mounts[f"all://{hostname}"] = None
            else:
                mounts[f"all://*{hostname}"] = None

    return mounts
