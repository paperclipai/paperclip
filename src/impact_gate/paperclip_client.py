"""Re-export Paperclip API client from the touch_index package.

Impact Gate uses the same Paperclip API client as Touch Index to avoid
duplicating HTTP session logic, credential validation, pagination, and
retry configuration.
"""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

_sys.path.insert(0, str(_Path(__file__).parent.parent / "touch_index"))

from touch_index.paperclip_client import (  # noqa: F401, E402
    check_paperclip_credentials,
    get_issue_by_id,
    get_issue_by_identifier,
    get_all_done_issues,
    get_closed_bug_issues,
    get_closed_non_fdr_issues,
    is_issue_done,
    get_issue_status,
    FDR_LABEL_ID,
)
