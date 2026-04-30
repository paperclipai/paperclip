import ctypes
# pylint: disable=import-error,no-name-in-module
from ctypes.macholib.dyld import dyld_find


class DLInfo:  # pylint: disable=too-few-public-methods

    """
    >>> lib = ctypes.cdll.LoadLibrary(ctypes.util.find_library('c'))
    >>> dlinfo = DLInfo(lib)
    >>> dlinfo.path
    '/usr/lib/libc.dylib'
    """

    def __init__(self, cdll: ctypes.CDLL):
        self._cdll = cdll

    @property
    def path(self) -> str:
        # pylint: disable=protected-access
        return dyld_find(self._cdll._name)
