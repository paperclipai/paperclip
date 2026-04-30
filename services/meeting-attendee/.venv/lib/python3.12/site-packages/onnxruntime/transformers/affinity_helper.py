# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

# Get/Set cpu affinity. Currently only support part of Unix system
import logging
import os

logger = logging.getLogger(__name__)


class AffinitySetting:
    def __init__(self):
        self.pid = os.getpid()
        self.affinity = None
        self.is_os_supported = hasattr(os, "sched_getaffinity") and hasattr(os, "sched_setaffinity")
        if not self.is_os_supported:
            logger.warning("Current OS does not support os.get_affinity() and os.set_affinity()")

    def get_affinity(self):
        if self.is_os_supported:
            self.affinity = os.sched_getaffinity(self.pid)

    def set_affinity(self):
        if self.is_os_supported:
            current_affinity = os.sched_getaffinity(self.pid)
            if self.affinity != current_affinity:
                logger.warning(
                    "Replacing affinity setting %s with %s",
                    str(current_affinity),
                    str(self.affinity),
                )
                os.sched_setaffinity(self.pid, self.affinity)


if __name__ == "__main__":
    affi_helper = AffinitySetting()
    affi_helper.get_affinity()
    affi_helper.set_affinity()
