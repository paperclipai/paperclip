"""
OpenShell pool RAM monitor — SAG-2357 ops monitoring requirement.

Reports pool RAM and posts a Paperclip comment when total pool RAM
exceeds the alert threshold (default 200 MiB; 5× measured floor of ~42 MiB).

Usage (from batch runner or standalone):
    from scripts.opensh_shim.monitor import PoolMonitor
    mon = PoolMonitor(cfg, pool, api_url=..., api_key=..., issue_id=...)
    await mon.check_and_alert()
"""
from __future__ import annotations

import logging

import httpx

from .config import ShimConfig
from .pool import SandboxPool

logger = logging.getLogger(__name__)


class PoolMonitor:
    def __init__(
        self,
        cfg: ShimConfig,
        pool: SandboxPool,
        api_url: str = "",
        api_key: str = "",
        issue_id: str = "",
        run_id: str = "",
    ) -> None:
        self._cfg = cfg
        self._pool = pool
        self._api_url = api_url
        self._api_key = api_key
        self._issue_id = issue_id
        self._run_id = run_id

    def pool_ram_mib(self) -> float:
        return self._pool.pool_ram_mib()

    async def check_and_alert(self) -> dict:
        """
        Read pool RAM, return metrics dict, and post a Paperclip alert if
        total RAM exceeds cfg.ram_alert_mib (default 200 MiB).

        Returns:
            {"pool_ram_mib": float, "pool_size": int, "alert_fired": bool}
        """
        ram = self.pool_ram_mib()
        size = self._pool.size()
        alert_fired = False

        logger.info("OpenShell pool RAM: %.1f MiB (size=%d)", ram, size)

        if ram > self._cfg.ram_alert_mib:
            logger.warning(
                "OpenShell pool RAM alert: %.1f MiB > threshold %.1f MiB",
                ram, self._cfg.ram_alert_mib,
            )
            if self._api_url and self._api_key and self._issue_id:
                await self._post_alert(ram)
                alert_fired = True

        return {"pool_ram_mib": ram, "pool_size": size, "alert_fired": alert_fired}

    async def _post_alert(self, ram_mib: float) -> None:
        body = (
            f"## OpenShell pool RAM alert\n\n"
            f"Total pool RAM: **{ram_mib:.1f} MiB** exceeds threshold of "
            f"**{self._cfg.ram_alert_mib:.0f} MiB**.\n\n"
            f"| Metric | Value |\n"
            f"|--------|-------|\n"
            f"| Pool size | {self._pool.size()} sandboxes |\n"
            f"| Total RAM | {ram_mib:.1f} MiB |\n"
            f"| Threshold | {self._cfg.ram_alert_mib:.0f} MiB |\n"
            f"| Tag | `{self._cfg.sandbox_tag}` |\n\n"
            f"Investigate with `docker stats --filter label=openshell.ai/sandbox-pool=true`.\n\n"
            f"Baseline: ~42 MiB at pool=3 (measured [SAG-2294](/SAG/issues/SAG-2294))."
        )
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "X-Paperclip-Run-Id": self._run_id,
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                r = await client.post(
                    f"{self._api_url}/api/issues/{self._issue_id}/comments",
                    headers=headers,
                    json={"body": body},
                )
                r.raise_for_status()
                logger.info("Pool RAM alert posted to issue %s", self._issue_id)
            except Exception as exc:
                logger.error("Failed to post pool RAM alert: %s", exc)
