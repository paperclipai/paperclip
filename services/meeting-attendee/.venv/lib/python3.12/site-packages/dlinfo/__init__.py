__all__ = ['DLInfo']

import sys

# pylint: disable=import-private-name; internal
if sys.platform == 'darwin':
    from dlinfo._macosx import DLInfo
else:
    from dlinfo._glibc import DLInfo
