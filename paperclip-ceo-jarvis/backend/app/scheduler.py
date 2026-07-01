import asyncio
from contextlib import suppress
from .config import get_settings
from .db import SessionLocal
from .services.watchdog import run_watch_cycle

_task: asyncio.Task | None = None


async def _loop():
    settings = get_settings()
    while True:
        db = SessionLocal()
        try:
            run_watch_cycle(db)
        finally:
            db.close()
        await asyncio.sleep(max(10, settings.watch_interval_seconds))


def start_scheduler():
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())


async def stop_scheduler():
    global _task
    if _task:
        _task.cancel()
        with suppress(asyncio.CancelledError):
            await _task
        _task = None
