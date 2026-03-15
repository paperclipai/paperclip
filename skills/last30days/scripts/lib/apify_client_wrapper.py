"""Shared Apify client utilities for last30days sources.

Provides a common wrapper around the apify-client SDK so that
TikTok, Facebook, Instagram (future) all share the same client
initialization, error handling, and cost-control patterns.

One APIFY_API_TOKEN covers all Apify-backed sources.
"""

import sys
from typing import Any, Dict, List, Optional

try:
    from apify_client import ApifyClient
except ImportError:
    ApifyClient = None


def is_apify_available() -> bool:
    """Check if the apify-client library is installed."""
    return ApifyClient is not None


def get_apify_client(token: str) -> "ApifyClient":
    """Initialize Apify client with token.

    Args:
        token: Apify API token (from https://console.apify.com)

    Returns:
        Initialized ApifyClient instance

    Raises:
        ImportError: If apify-client is not installed
    """
    if ApifyClient is None:
        raise ImportError(
            "apify-client is not installed. Run: pip install apify-client"
        )
    return ApifyClient(token=token)


def run_actor_sync(
    client: "ApifyClient",
    actor_id: str,
    run_input: Dict[str, Any],
    timeout_secs: int = 300,
    max_items: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Run an Apify actor synchronously and return dataset items.

    Args:
        client: Initialized ApifyClient
        actor_id: Actor identifier, e.g. "clockworks/tiktok-scraper"
        run_input: Actor-specific input dict
        timeout_secs: Max wait time (default 5 min)
        max_items: Cap on returned items (cost control)

    Returns:
        List of result dicts from the actor's default dataset
    """
    run = client.actor(actor_id).call(
        run_input=run_input,
        timeout_secs=timeout_secs,
        logger=None,  # Suppress verbose actor log streaming to stderr
    )

    dataset_id = run["defaultDatasetId"]
    items = list(client.dataset(dataset_id).iterate_items())

    if max_items and len(items) > max_items:
        items = items[:max_items]
    return items


def _log(msg: str):
    """Log to stderr (only in interactive terminals; spinner handles non-TTY)."""
    if sys.stderr.isatty():
        sys.stderr.write(f"[Apify] {msg}\n")
        sys.stderr.flush()
