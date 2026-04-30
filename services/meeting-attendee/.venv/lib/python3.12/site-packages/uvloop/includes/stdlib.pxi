# flake8: noqa


import asyncio, asyncio.log, asyncio.base_events, \
       asyncio.sslproto, asyncio.coroutines, \
       asyncio.futures, asyncio.transports
import collections.abc
import concurrent.futures
import errno
import functools
import gc
import inspect
import itertools
import os
import signal
import socket
import subprocess
import ssl
import stat
import sys
import threading
import traceback
import time
import warnings
import weakref


cdef aio_get_event_loop = asyncio.get_event_loop
cdef aio_CancelledError = asyncio.CancelledError
cdef aio_InvalidStateError = asyncio.InvalidStateError
cdef aio_TimeoutError = asyncio.TimeoutError
cdef aio_Future = asyncio.Future
cdef aio_Task = asyncio.Task
cdef aio_ensure_future = asyncio.ensure_future
cdef aio_gather = asyncio.gather
cdef aio_wait = asyncio.wait
cdef aio_wrap_future = asyncio.wrap_future
cdef aio_logger = asyncio.log.logger
cdef aio_iscoroutine = asyncio.iscoroutine
cdef aio_iscoroutinefunction = asyncio.iscoroutinefunction
cdef aio_BaseProtocol = asyncio.BaseProtocol
cdef aio_Protocol = asyncio.Protocol
cdef aio_isfuture = getattr(asyncio, 'isfuture', None)
cdef aio_get_running_loop = getattr(asyncio, '_get_running_loop', None)
cdef aio_set_running_loop = getattr(asyncio, '_set_running_loop', None)
cdef aio_debug_wrapper = getattr(asyncio.coroutines, 'debug_wrapper', None)
cdef aio_AbstractChildWatcher = getattr(asyncio, "AbstractChildWatcher", ())
cdef aio_Transport = asyncio.Transport
cdef aio_FlowControlMixin = asyncio.transports._FlowControlMixin

cdef col_deque = collections.deque
cdef col_Iterable = collections.abc.Iterable
cdef col_Counter = collections.Counter
cdef col_OrderedDict = collections.OrderedDict

cdef cc_ThreadPoolExecutor = concurrent.futures.ThreadPoolExecutor
cdef cc_Future = concurrent.futures.Future

cdef errno_EBADF = errno.EBADF
cdef errno_EINVAL = errno.EINVAL

cdef ft_partial = functools.partial

cdef gc_disable = gc.disable

cdef iter_chain = itertools.chain
cdef inspect_isgenerator = inspect.isgenerator

cdef int has_IPV6_V6ONLY = hasattr(socket, 'IPV6_V6ONLY')
cdef int IPV6_V6ONLY = getattr(socket, 'IPV6_V6ONLY', -1)
cdef int has_SO_REUSEPORT = hasattr(socket, 'SO_REUSEPORT')
cdef int SO_REUSEPORT = getattr(socket, 'SO_REUSEPORT', 0)
cdef int SO_BROADCAST = getattr(socket, 'SO_BROADCAST')
cdef int SOCK_NONBLOCK = getattr(socket, 'SOCK_NONBLOCK', -1)
cdef int socket_AI_CANONNAME = getattr(socket, 'AI_CANONNAME')

cdef socket_gaierror = socket.gaierror
cdef socket_error = socket.error
cdef socket_timeout = socket.timeout
cdef socket_socket = socket.socket
cdef socket_socketpair = socket.socketpair
cdef socket_getservbyname = socket.getservbyname
cdef socket_AddressFamily = socket.AddressFamily
cdef socket_SocketKind = socket.SocketKind

cdef int socket_EAI_ADDRFAMILY = getattr(socket, 'EAI_ADDRFAMILY', -1)
cdef int socket_EAI_AGAIN      = getattr(socket, 'EAI_AGAIN', -1)
cdef int socket_EAI_BADFLAGS   = getattr(socket, 'EAI_BADFLAGS', -1)
cdef int socket_EAI_BADHINTS   = getattr(socket, 'EAI_BADHINTS', -1)
cdef int socket_EAI_CANCELED   = getattr(socket, 'EAI_CANCELED', -1)
cdef int socket_EAI_FAIL       = getattr(socket, 'EAI_FAIL', -1)
cdef int socket_EAI_FAMILY     = getattr(socket, 'EAI_FAMILY', -1)
cdef int socket_EAI_MEMORY     = getattr(socket, 'EAI_MEMORY', -1)
cdef int socket_EAI_NODATA     = getattr(socket, 'EAI_NODATA', -1)
cdef int socket_EAI_NONAME     = getattr(socket, 'EAI_NONAME', -1)
cdef int socket_EAI_OVERFLOW   = getattr(socket, 'EAI_OVERFLOW', -1)
cdef int socket_EAI_PROTOCOL   = getattr(socket, 'EAI_PROTOCOL', -1)
cdef int socket_EAI_SERVICE    = getattr(socket, 'EAI_SERVICE', -1)
cdef int socket_EAI_SOCKTYPE   = getattr(socket, 'EAI_SOCKTYPE', -1)


cdef str os_name = os.name
cdef os_environ = os.environ
cdef os_dup = os.dup
cdef os_set_inheritable = os.set_inheritable
cdef os_get_inheritable = os.get_inheritable
cdef os_close = os.close
cdef os_open = os.open
cdef os_devnull = os.devnull
cdef os_O_RDWR = os.O_RDWR
cdef os_pipe = os.pipe
cdef os_read = os.read
cdef os_remove = os.remove
cdef os_stat = os.stat
cdef os_unlink = os.unlink
cdef os_fspath = os.fspath

cdef stat_S_ISSOCK = stat.S_ISSOCK

cdef sys_ignore_environment = sys.flags.ignore_environment
cdef sys_dev_mode = sys.flags.dev_mode
cdef sys_exc_info = sys.exc_info
cdef sys_set_coroutine_wrapper = getattr(sys, 'set_coroutine_wrapper', None)
cdef sys_get_coroutine_wrapper = getattr(sys, 'get_coroutine_wrapper', None)
cdef sys_getframe = sys._getframe
cdef sys_version_info = sys.version_info
cdef sys_getfilesystemencoding = sys.getfilesystemencoding
cdef str sys_platform = sys.platform

cdef ssl_SSLContext = ssl.SSLContext
cdef ssl_MemoryBIO = ssl.MemoryBIO
cdef ssl_create_default_context = ssl.create_default_context
cdef ssl_SSLError = ssl.SSLError
cdef ssl_SSLAgainErrors = (ssl.SSLWantReadError, ssl.SSLSyscallError)
cdef ssl_SSLZeroReturnError = ssl.SSLZeroReturnError
cdef ssl_CertificateError = ssl.CertificateError
cdef int ssl_SSL_ERROR_WANT_READ = ssl.SSL_ERROR_WANT_READ
cdef int ssl_SSL_ERROR_WANT_WRITE = ssl.SSL_ERROR_WANT_WRITE
cdef int ssl_SSL_ERROR_SYSCALL = ssl.SSL_ERROR_SYSCALL

cdef threading_Thread = threading.Thread
cdef threading_main_thread = threading.main_thread

cdef int subprocess_PIPE = subprocess.PIPE
cdef int subprocess_STDOUT = subprocess.STDOUT
cdef int subprocess_DEVNULL = subprocess.DEVNULL
cdef subprocess_SubprocessError = subprocess.SubprocessError

cdef int signal_NSIG = signal.NSIG
cdef signal_signal = signal.signal
cdef signal_siginterrupt = signal.siginterrupt
cdef signal_set_wakeup_fd = signal.set_wakeup_fd
cdef signal_default_int_handler = signal.default_int_handler
cdef signal_SIG_DFL = signal.SIG_DFL

cdef time_sleep = time.sleep
cdef time_monotonic = time.monotonic

cdef tb_StackSummary = traceback.StackSummary
cdef tb_walk_stack = traceback.walk_stack
cdef tb_format_list = traceback.format_list

cdef warnings_warn = warnings.warn

cdef weakref_WeakValueDictionary = weakref.WeakValueDictionary
cdef weakref_WeakSet = weakref.WeakSet

cdef py_inf = float('inf')


# Cython doesn't clean-up imported objects properly in Py3 mode,
# so we delete refs to all modules manually (except sys)
del asyncio, concurrent, collections, errno
del functools, inspect, itertools, socket, os, threading
del signal, subprocess, ssl
del time, traceback, warnings, weakref
