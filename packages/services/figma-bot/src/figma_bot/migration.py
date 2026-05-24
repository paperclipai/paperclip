"""One-shot, idempotent migration of the pre-T6 profile layout.

Before T6, the bot had a single hard-coded profile at
`/config/playwright-profile/`. T6's multi-identity layout moves this
under `/config/profiles/<sha16-of-default>/playwright-profile/` so
multiple identities can co-exist on the same PVC.

The migration runs at every boot but is a no-op after the first
successful rename. Same-fs `os.rename` is atomic.
"""

from __future__ import annotations

import os

from . import state
from .config import LEGACY_BACKUP_DIR, LEGACY_PROFILE_DIR, PROFILES_ROOT
from .identity_registry import slug_for


def migrate_legacy_profile_layout() -> None:
    """Idempotent: move /config/playwright-profile/ under
    /config/profiles/<sha16-of-default>/. Skips if target exists or no
    default identity resolvable."""
    if state.identities is None:
        state.log("migration: skipping — IdentityRegistry not initialized")
        return
    default = state.identities.default_identity()
    if default is None:
        state.log("migration: no default identity; legacy dir untouched")
        return
    slug = slug_for(default)
    target_profile = os.path.join(PROFILES_ROOT, slug, "playwright-profile")
    target_backup = os.path.join(PROFILES_ROOT, slug, "playwright-profile-backup")
    target_email = os.path.join(PROFILES_ROOT, slug, "email.txt")
    if os.path.exists(target_profile):
        state.log(f"migration: target {target_profile} already exists; skipping main rename")
    elif not os.path.exists(LEGACY_PROFILE_DIR):
        state.log("migration: no legacy /config/playwright-profile/; skipping main rename")
    else:
        try:
            os.makedirs(os.path.join(PROFILES_ROOT, slug), exist_ok=True)
        except OSError as e:
            state.log(f"migration: makedirs failed for {PROFILES_ROOT}/{slug}: {e}; aborting")
            return
        try:
            os.rename(LEGACY_PROFILE_DIR, target_profile)
            state.log(f"migration: renamed {LEGACY_PROFILE_DIR} -> {target_profile}")
        except OSError as e:
            state.log(f"migration: rename profile failed: {e}; aborting")
            return
    if os.path.exists(LEGACY_BACKUP_DIR) and not os.path.exists(target_backup):
        try:
            os.rename(LEGACY_BACKUP_DIR, target_backup)
            state.log(f"migration: renamed {LEGACY_BACKUP_DIR} -> {target_backup}")
        except OSError as e:
            state.log(f"migration: rename backup failed: {e}")
    if not os.path.exists(target_email):
        try:
            with open(target_email, "w") as f:
                f.write(default + "\n")
            state.log(f"migration: wrote {target_email}")
        except OSError as e:
            state.log(f"migration: email.txt write failed: {e}")
