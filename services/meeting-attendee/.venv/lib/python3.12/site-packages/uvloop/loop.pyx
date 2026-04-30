# cython: language_level=3, embedsignature=True, freethreading_compatible=True

import asyncio
cimport cython

from .includes.debug cimport UVLOOP_DEBUG
from .includes cimport uv
from .includes cimport system
from .includes.python cimport (
    PY_VERSION_HEX,
    PyMem_RawMalloc, PyMem_RawFree,
    PyMem_RawCalloc, PyMem_RawRealloc,
    PyUnicode_EncodeFSDefault,
    PyErr_SetInterrupt,
    _Py_RestoreSignals,
    Context_CopyCurrent,
    Context_Enter,
    Context_Exit,
    PyMemoryView_FromMemory, PyBUF_WRITE,
    PyMemoryView_FromObject, PyMemoryView_Check,
    PyOS_AfterFork_Parent, PyOS_AfterFork_Child,
    PyOS_BeforeFork,
    PyUnicode_FromString
)
from .includes.flowcontrol cimport add_flowcontrol_defaults

from libc.stdint cimport uint64_t
from libc.string cimport memset, strerror, memcpy
from libc cimport errno

from cpython cimport PyObject
from cpython cimport PyErr_CheckSignals, PyErr_Occurred
from cpython cimport PyThread_get_thread_ident
from cpython cimport Py_INCREF, Py_DECREF, Py_XDECREF, Py_XINCREF
from cpython cimport (
    PyObject_GetBuffer, PyBuffer_Release, PyBUF_SIMPLE,
    Py_buffer, PyBytes_AsString, PyBytes_CheckExact,
    PyBytes_AsStringAndSize,
    Py_SIZE, PyBytes_AS_STRING, PyBUF_WRITABLE
)
from cpython.pycapsule cimport PyCapsule_New, PyCapsule_GetPointer

from . import _noop


include "includes/stdlib.pxi"

include "errors.pyx"

cdef:
    int PY39 = PY_VERSION_HEX >= 0x03090000
    int PY311 = PY_VERSION_HEX >= 0x030b0000
    int PY313 = PY_VERSION_HEX >= 0x030d0000
    uint64_t MAX_SLEEP = 3600 * 24 * 365 * 100


cdef _is_sock_stream(sock_type):
    if SOCK_NONBLOCK == -1:
        return sock_type == uv.SOCK_STREAM
    else:
        # Linux's socket.type is a bitmask that can include extra info
        # about socket (like SOCK_NONBLOCK bit), therefore we can't do simple
        # `sock_type == socket.SOCK_STREAM`, see
        # https://github.com/torvalds/linux/blob/v4.13/include/linux/net.h#L77
        # for more details.
        return (sock_type & 0xF) == uv.SOCK_STREAM


cdef _is_sock_dgram(sock_type):
    if SOCK_NONBLOCK == -1:
        return sock_type == uv.SOCK_DGRAM
    else:
        # Read the comment in `_is_sock_stream`.
        return (sock_type & 0xF) == uv.SOCK_DGRAM


cdef isfuture(obj):
    if aio_isfuture is None:
        return isinstance(obj, aio_Future)
    else:
        return aio_isfuture(obj)


cdef inline socket_inc_io_ref(sock):
    if isinstance(sock, socket_socket):
        sock._io_refs += 1


cdef inline socket_dec_io_ref(sock):
    if isinstance(sock, socket_socket):
        sock._decref_socketios()


cdef inline run_in_context(context, method):
    # This method is internally used to workaround a reference issue that in
    # certain circumstances, inlined context.run() will not hold a reference to
    # the given method instance, which - if deallocated - will cause segfault.
    # See also: edgedb/edgedb#2222
    Py_INCREF(method)
    try:
        return context.run(method)
    finally:
        Py_DECREF(method)


cdef inline run_in_context1(context, method, arg):
    Py_INCREF(method)
    try:
        return context.run(method, arg)
    finally:
        Py_DECREF(method)


cdef inline run_in_context2(context, method, arg1, arg2):
    Py_INCREF(method)
    try:
        return context.run(method, arg1, arg2)
    finally:
        Py_DECREF(method)


# Used for deprecation and removal of `loop.create_datagram_endpoint()`'s
# *reuse_address* parameter
_unset = object()


@cython.no_gc_clear
cdef class Loop:
    def __cinit__(self):
        cdef int err

        # Install PyMem* memory allocators if they aren't installed yet.
        __install_pymem()

        # Install pthread_atfork handlers
        __install_atfork()

        self.uvloop = <uv.uv_loop_t*>PyMem_RawMalloc(sizeof(uv.uv_loop_t))
        if self.uvloop is NULL:
            raise MemoryError()

        self.slow_callback_duration = 0.1

        self._closed = 0
        self._debug = 0
        self._thread_id = 0
        self._running = 0
        self._stopping = 0

        self._transports = weakref_WeakValueDictionary()
        self._processes = set()

        # Used to keep a reference (and hence keep the fileobj alive)
        # for as long as its registered by add_reader or add_writer.
        # This is how the selector module and hence asyncio behaves.
        self._fd_to_reader_fileobj = {}
        self._fd_to_writer_fileobj = {}

        self._unix_server_sockets = {}

        self._timers = set()
        self._polls = {}

        self._recv_buffer_in_use = 0

        err = uv.uv_loop_init(self.uvloop)
        if err < 0:
            raise convert_error(err)
        self.uvloop.data = <void*> self

        self._init_debug_fields()

        self.active_process_handler = None

        self._last_error = None

        self._task_factory = None
        self._exception_handler = None
        self._default_executor = None

        self._queued_streams = set()
        self._executing_streams = set()
        self._ready = col_deque()
        self._ready_len = 0

        self.handler_async = UVAsync.new(
            self, <method_t>self._on_wake, self)

        self.handler_idle = UVIdle.new(
            self,
            new_MethodHandle(
                self, "loop._on_idle", <method_t>self._on_idle, None, self))

        # Needed to call `UVStream._exec_write` for writes scheduled
        # during `Protocol.data_received`.
        self.handler_check__exec_writes = UVCheck.new(
            self,
            new_MethodHandle(
                self, "loop._exec_queued_writes",
                <method_t>self._exec_queued_writes, None, self))

        self._signals = set()
        self._ssock = self._csock = None
        self._signal_handlers = {}
        self._listening_signals = False
        self._old_signal_wakeup_id = -1

        self._coroutine_debug_set = False

        # A weak set of all asynchronous generators that are
        # being iterated by the loop.
        self._asyncgens = weakref_WeakSet()

        # Set to True when `loop.shutdown_asyncgens` is called.
        self._asyncgens_shutdown_called = False
        # Set to True when `loop.shutdown_default_executor` is called.
        self._executor_shutdown_called = False

        self._servers = set()

    cdef inline _is_main_thread(self):
        cdef uint64_t main_thread_id = system.MAIN_THREAD_ID
        if system.MAIN_THREAD_ID_SET == 0:
            main_thread_id = <uint64_t>threading_main_thread().ident
            system.setMainThreadID(main_thread_id)
        return main_thread_id == PyThread_get_thread_ident()

    def __init__(self):
        self.set_debug(
            sys_dev_mode or (not sys_ignore_environment
                             and bool(os_environ.get('PYTHONASYNCIODEBUG'))))

    def __dealloc__(self):
        if self._running == 1:
            raise RuntimeError('deallocating a running event loop!')
        if self._closed == 0:
            aio_logger.error("deallocating an open event loop")
            return
        PyMem_RawFree(self.uvloop)
        self.uvloop = NULL

    cdef _init_debug_fields(self):
        self._debug_cc = bool(UVLOOP_DEBUG)

        if UVLOOP_DEBUG:
            self._debug_handles_current = col_Counter()
            self._debug_handles_closed = col_Counter()
            self._debug_handles_total = col_Counter()
        else:
            self._debug_handles_current = None
            self._debug_handles_closed = None
            self._debug_handles_total = None

        self._debug_uv_handles_total = 0
        self._debug_uv_handles_freed = 0

        self._debug_stream_read_cb_total = 0
        self._debug_stream_read_eof_total = 0
        self._debug_stream_read_errors_total = 0
        self._debug_stream_read_cb_errors_total = 0
        self._debug_stream_read_eof_cb_errors_total = 0

        self._debug_stream_shutdown_errors_total = 0
        self._debug_stream_listen_errors_total = 0

        self._debug_stream_write_tries = 0
        self._debug_stream_write_errors_total = 0
        self._debug_stream_write_ctx_total = 0
        self._debug_stream_write_ctx_cnt = 0
        self._debug_stream_write_cb_errors_total = 0

        self._debug_cb_handles_total = 0
        self._debug_cb_handles_count = 0

        self._debug_cb_timer_handles_total = 0
        self._debug_cb_timer_handles_count = 0

        self._poll_read_events_total = 0
        self._poll_read_cb_errors_total = 0
        self._poll_write_events_total = 0
        self._poll_write_cb_errors_total = 0

        self._sock_try_write_total = 0

        self._debug_exception_handler_cnt = 0

    cdef _setup_or_resume_signals(self):
        if not self._is_main_thread():
            return

        if self._listening_signals:
            raise RuntimeError('signals handling has been already setup')

        if self._ssock is not None:
            raise RuntimeError('self-pipe exists before loop run')

        # Create a self-pipe and call set_signal_wakeup_fd() with one
        # of its ends.  This is needed so that libuv knows that it needs
        # to wakeup on ^C (no matter if the SIGINT handler is still the
        # standard Python's one or or user set their own.)

        self._ssock, self._csock = socket_socketpair()
        try:
            self._ssock.setblocking(False)
            self._csock.setblocking(False)

            fileno = self._csock.fileno()

            self._old_signal_wakeup_id = _set_signal_wakeup_fd(fileno)
        except Exception:
            # Out of all statements in the try block, only the
            # "_set_signal_wakeup_fd()" call can fail, but it shouldn't,
            # as we ensure that the current thread is the main thread.
            # Still, if something goes horribly wrong we want to clean up
            # the socket pair.
            self._ssock.close()
            self._csock.close()
            self._ssock = None
            self._csock = None
            raise

        self._add_reader(
            self._ssock,
            new_MethodHandle(
                self,
                "Loop._read_from_self",
                <method_t>self._read_from_self,
                None,
                self))

        self._listening_signals = True

    cdef _pause_signals(self):
        if not self._is_main_thread():
            if self._listening_signals:
                raise RuntimeError(
                    'cannot pause signals handling; no longer running in '
                    'the main thread')
            else:
                return

        if not self._listening_signals:
            raise RuntimeError('signals handling has not been setup')

        self._listening_signals = False

        _set_signal_wakeup_fd(self._old_signal_wakeup_id)

        self._remove_reader(self._ssock)
        self._ssock.close()
        self._csock.close()
        self._ssock = None
        self._csock = None

    cdef _shutdown_signals(self):
        if not self._is_main_thread():
            if self._signal_handlers:
                aio_logger.warning(
                    'cannot cleanup signal handlers: closing the event loop '
                    'in a non-main OS thread')
            return

        if self._listening_signals:
            raise RuntimeError(
                'cannot shutdown signals handling as it has not been paused')

        if self._ssock:
            raise RuntimeError(
                'self-pipe was not cleaned up after loop was run')

        for sig in list(self._signal_handlers):
            self.remove_signal_handler(sig)

    def __sighandler(self, signum, frame):
        self._signals.add(signum)

    cdef inline _ceval_process_signals(self):
        # Invoke CPython eval loop to let process signals.
        PyErr_CheckSignals()
        # Calling a pure-Python function will invoke
        # _PyEval_EvalFrameDefault which will process
        # pending signal callbacks.
        _noop.noop()  # Might raise ^C

    cdef _read_from_self(self):
        cdef bytes sigdata
        sigdata = b''
        while True:
            try:
                data = self._ssock.recv(65536)
                if not data:
                    break
                sigdata += data
            except InterruptedError:
                continue
            except BlockingIOError:
                break
        if sigdata:
            self._invoke_signals(sigdata)

    cdef _invoke_signals(self, bytes data):
        cdef set sigs

        self._ceval_process_signals()

        sigs = self._signals.copy()
        self._signals.clear()
        for signum in data:
            if not signum:
                # ignore null bytes written by set_wakeup_fd()
                continue
            sigs.discard(signum)
            self._handle_signal(signum)

        for signum in sigs:
            # Since not all signals are registered by add_signal_handler()
            # (for instance, we use the default SIGINT handler) not all
            # signals will trigger loop.__sighandler() callback.  Therefore
            # we combine two datasources: one is self-pipe, one is data
            # from __sighandler; this ensures that signals shouldn't be
            # lost even if set_wakeup_fd() couldn't write to the self-pipe.
            self._handle_signal(signum)

    cdef _handle_signal(self, sig):
        cdef Handle handle

        try:
            handle = <Handle>(self._signal_handlers[sig])
        except KeyError:
            handle = None

        if handle is None:
            self._ceval_process_signals()
            return

        if handle._cancelled:
            self.remove_signal_handler(sig)  # Remove it properly.
        else:
            self._append_ready_handle(handle)
            self.handler_async.send()

    cdef _on_wake(self):
        if ((self._ready_len > 0 or self._stopping) and
                not self.handler_idle.running):
            self.handler_idle.start()

    cdef _on_idle(self):
        cdef:
            int i, ntodo
            object popleft = self._ready.popleft
            Handle handler

        ntodo = len(self._ready)
        if self._debug:
            for i from 0 <= i < ntodo:
                handler = <Handle> popleft()
                if handler._cancelled == 0:
                    try:
                        started = time_monotonic()
                        handler._run()
                    except BaseException as ex:
                        self._stop(ex)
                        return
                    else:
                        delta = time_monotonic() - started
                        if delta > self.slow_callback_duration:
                            aio_logger.warning(
                                'Executing %s took %.3f seconds',
                                handler._format_handle(), delta)

        else:
            for i from 0 <= i < ntodo:
                handler = <Handle> popleft()
                if handler._cancelled == 0:
                    try:
                        handler._run()
                    except BaseException as ex:
                        self._stop(ex)
                        return

        if len(self._queued_streams):
            self._exec_queued_writes()

        self._ready_len = len(self._ready)
        if self._ready_len == 0 and self.handler_idle.running:
            self.handler_idle.stop()

        if self._stopping:
            uv.uv_stop(self.uvloop)  # void

    cdef _stop(self, exc):
        if exc is not None:
            self._last_error = exc
        if self._stopping == 1:
            return
        self._stopping = 1
        if not self.handler_idle.running:
            self.handler_idle.start()

    cdef __run(self, uv.uv_run_mode mode):
        # Although every UVHandle holds a reference to the loop,
        # we want to do everything to ensure that the loop will
        # never deallocate during the run -- so we do some
        # manual refs management.
        Py_INCREF(self)
        with nogil:
            err = uv.uv_run(self.uvloop, mode)
        Py_DECREF(self)

        if err < 0:
            raise convert_error(err)

    cdef _run(self, uv.uv_run_mode mode):
        cdef int err

        if self._closed == 1:
            raise RuntimeError('unable to start the loop; it was closed')

        if self._running == 1:
            raise RuntimeError('this event loop is already running.')

        if (aio_get_running_loop is not None and
                aio_get_running_loop() is not None):
            raise RuntimeError(
                'Cannot run the event loop while another loop is running')

        # reset _last_error
        self._last_error = None

        self._thread_id = PyThread_get_thread_ident()
        self._running = 1

        self.handler_check__exec_writes.start()
        self.handler_idle.start()

        self._setup_or_resume_signals()

        if aio_set_running_loop is not None:
            aio_set_running_loop(self)
        try:
            self.__run(mode)
        finally:
            if aio_set_running_loop is not None:
                aio_set_running_loop(None)

            self.handler_check__exec_writes.stop()
            self.handler_idle.stop()

            self._pause_signals()

            self._thread_id = 0
            self._running = 0
            self._stopping = 0

        if self._last_error is not None:
            # The loop was stopped with an error with 'loop._stop(error)' call
            raise self._last_error

    cdef _close(self):
        cdef int err

        if self._running == 1:
            raise RuntimeError("Cannot close a running event loop")

        if self._closed == 1:
            return

        self._closed = 1

        for cb_handle in self._ready:
            cb_handle.cancel()
        self._ready.clear()
        self._ready_len = 0

        if self._polls:
            for poll_handle in self._polls.values():
                (<UVHandle>poll_handle)._close()

            self._polls.clear()

        if self._timers:
            for timer_cbhandle in tuple(self._timers):
                timer_cbhandle.cancel()

        # Close all remaining handles
        self.handler_async._close()
        self.handler_idle._close()
        self.handler_check__exec_writes._close()
        __close_all_handles(self)
        self._shutdown_signals()
        # During this run there should be no open handles,
        # so it should finish right away
        self.__run(uv.UV_RUN_DEFAULT)

        if self._fd_to_writer_fileobj:
            for fileobj in self._fd_to_writer_fileobj.values():
                socket_dec_io_ref(fileobj)
            self._fd_to_writer_fileobj.clear()

        if self._fd_to_reader_fileobj:
            for fileobj in self._fd_to_reader_fileobj.values():
                socket_dec_io_ref(fileobj)
            self._fd_to_reader_fileobj.clear()

        if self._timers:
            raise RuntimeError(
                f"new timers were queued during loop closing: {self._timers}")

        if self._polls:
            raise RuntimeError(
                f"new poll handles were queued during loop closing: "
                f"{self._polls}")

        if self._ready:
            raise RuntimeError(
                f"new callbacks were queued during loop closing: "
                f"{self._ready}")

        err = uv.uv_loop_close(self.uvloop)
        if err < 0:
            raise convert_error(err)

        self.handler_async = None
        self.handler_idle = None
        self.handler_check__exec_writes = None

        self._executor_shutdown_called = True
        executor = self._default_executor
        if executor is not None:
            self._default_executor = None
            executor.shutdown(wait=False)

    cdef uint64_t _time(self):
        # asyncio doesn't have a time cache, neither should uvloop.
        uv.uv_update_time(self.uvloop)  # void
        return uv.uv_now(self.uvloop)

    cdef inline _queue_write(self, UVStream stream):
        self._queued_streams.add(stream)
        if not self.handler_check__exec_writes.running:
            self.handler_check__exec_writes.start()

    cdef _exec_queued_writes(self):
        if len(self._queued_streams) == 0:
            if self.handler_check__exec_writes.running:
                self.handler_check__exec_writes.stop()
            return

        cdef:
            UVStream stream

        streams = self._queued_streams
        self._queued_streams = self._executing_streams
        self._executing_streams = streams
        try:
            for pystream in streams:
                stream = <UVStream>pystream
                stream._exec_write()
        finally:
            streams.clear()

        if self.handler_check__exec_writes.running:
            if len(self._queued_streams) == 0:
                self.handler_check__exec_writes.stop()

    cdef inline _call_soon(self, object callback, object args, object context):
        cdef Handle handle
        handle = new_Handle(self, callback, args, context)
        self._call_soon_handle(handle)
        return handle

    cdef inline _append_ready_handle(self, Handle handle):
        self._check_closed()
        self._ready.append(handle)
        self._ready_len += 1

    cdef inline _call_soon_handle(self, Handle handle):
        self._append_ready_handle(handle)
        if not self.handler_idle.running:
            self.handler_idle.start()

    cdef _call_later(self, uint64_t delay, object callback, object args,
                     object context):
        return TimerHandle(self, callback, args, delay, context)

    cdef void _handle_exception(self, object ex):
        if isinstance(ex, Exception):
            self.call_exception_handler({'exception': ex})
        else:
            # BaseException
            self._last_error = ex
            # Exit ASAP
            self._stop(None)

    cdef inline _check_signal(self, sig):
        if not isinstance(sig, int):
            raise TypeError('sig must be an int, not {!r}'.format(sig))

        if not (1 <= sig < signal_NSIG):
            raise ValueError(
                'sig {} out of range(1, {})'.format(sig, signal_NSIG))

    cdef inline _check_closed(self):
        if self._closed == 1:
            raise RuntimeError('Event loop is closed')

    cdef inline _check_thread(self):
        if self._thread_id == 0:
            return

        cdef uint64_t thread_id
        thread_id = <uint64_t>PyThread_get_thread_ident()

        if thread_id != self._thread_id:
            raise RuntimeError(
                "Non-thread-safe operation invoked on an event loop other "
                "than the current one")

    cdef inline _new_future(self):
        return aio_Future(loop=self)

    cdef _track_transport(self, UVBaseTransport transport):
        self._transports[transport._fileno()] = transport

    cdef _track_process(self, UVProcess proc):
        self._processes.add(proc)

    cdef _untrack_process(self, UVProcess proc):
        self._processes.discard(proc)

    cdef _fileobj_to_fd(self, fileobj):
        """Return a file descriptor from a file object.

        Parameters:
        fileobj -- file object or file descriptor

        Returns:
        corresponding file descriptor

        Raises:
        ValueError if the object is invalid
        """
        # Copy of the `selectors._fileobj_to_fd()` function.
        if isinstance(fileobj, int):
            fd = fileobj
        else:
            try:
                fd = int(fileobj.fileno())
            except (AttributeError, TypeError, ValueError):
                raise ValueError("Invalid file object: "
                                 "{!r}".format(fileobj)) from None
        if fd < 0:
            raise ValueError("Invalid file descriptor: {}".format(fd))
        return fd

    cdef _ensure_fd_no_transport(self, fd):
        cdef UVBaseTransport tr
        try:
            tr = <UVBaseTransport>(self._transports[fd])
        except KeyError:
            pass
        else:
            if tr._is_alive():
                raise RuntimeError(
                    'File descriptor {!r} is used by transport {!r}'.format(
                        fd, tr))

    cdef _add_reader(self, fileobj, Handle handle):
        cdef:
            UVPoll poll

        self._check_closed()
        fd = self._fileobj_to_fd(fileobj)
        self._ensure_fd_no_transport(fd)

        try:
            poll = <UVPoll>(self._polls[fd])
        except KeyError:
            poll = UVPoll.new(self, fd)
            self._polls[fd] = poll

        poll.start_reading(handle)

        old_fileobj = self._fd_to_reader_fileobj.pop(fd, None)
        if old_fileobj is not None:
            socket_dec_io_ref(old_fileobj)

        self._fd_to_reader_fileobj[fd] = fileobj
        socket_inc_io_ref(fileobj)

    cdef _remove_reader(self, fileobj):
        cdef:
            UVPoll poll

        fd = self._fileobj_to_fd(fileobj)
        self._ensure_fd_no_transport(fd)

        mapped_fileobj = self._fd_to_reader_fileobj.pop(fd, None)
        if mapped_fileobj is not None:
            socket_dec_io_ref(mapped_fileobj)

        if self._closed == 1:
            return False

        try:
            poll = <UVPoll>(self._polls[fd])
        except KeyError:
            return False

        result = poll.stop_reading()
        if not poll.is_active():
            del self._polls[fd]
            poll._close()

        return result

    cdef _has_reader(self, fileobj):
        cdef:
            UVPoll poll

        self._check_closed()
        fd = self._fileobj_to_fd(fileobj)

        try:
            poll = <UVPoll>(self._polls[fd])
        except KeyError:
            return False

        return poll.is_reading()

    cdef _add_writer(self, fileobj, Handle handle):
        cdef:
            UVPoll poll

        self._check_closed()
        fd = self._fileobj_to_fd(fileobj)
        self._ensure_fd_no_transport(fd)

        try:
            poll = <UVPoll>(self._polls[fd])
        except KeyError:
            poll = UVPoll.new(self, fd)
            self._polls[fd] = poll

        poll.start_writing(handle)

        old_fileobj = self._fd_to_writer_fileobj.pop(fd, None)
        if old_fileobj is not None:
            socket_dec_io_ref(old_fileobj)

        self._fd_to_writer_fileobj[fd] = fileobj
        socket_inc_io_ref(fileobj)

    cdef _remove_writer(self, fileobj):
        cdef:
            UVPoll poll

        fd = self._fileobj_to_fd(fileobj)
        self._ensure_fd_no_transport(fd)

        mapped_fileobj = self._fd_to_writer_fileobj.pop(fd, None)
        if mapped_fileobj is not None:
            socket_dec_io_ref(mapped_fileobj)

        if self._closed == 1:
            return False

        try:
            poll = <UVPoll>(self._polls[fd])
        except KeyError:
            return False

        result = poll.stop_writing()
        if not poll.is_active():
            del self._polls[fd]
            poll._close()

        return result

    cdef _has_writer(self, fileobj):
        cdef:
            UVPoll poll

        self._check_closed()
        fd = self._fileobj_to_fd(fileobj)

        try:
            poll = <UVPoll>(self._polls[fd])
        except KeyError:
            return False

        return poll.is_writing()

    cdef _getaddrinfo(self, object host, object port,
                      int family, int type,
                      int proto, int flags,
                      int unpack):

        if isinstance(port, str):
            port = port.encode()
        elif isinstance(port, int):
            port = str(port).encode()
        if port is not None and not isinstance(port, bytes):
            raise TypeError('port must be a str, bytes or int')

        if isinstance(host, str):
            host = host.encode('idna')
        if host is not None:
            if not isinstance(host, bytes):
                raise TypeError('host must be a str or bytes')

        fut = self._new_future()

        def callback(result):
            if AddrInfo.isinstance(result):
                try:
                    if unpack == 0:
                        data = result
                    else:
                        data = (<AddrInfo>result).unpack()
                except (KeyboardInterrupt, SystemExit):
                    raise
                except BaseException as ex:
                    if not fut.cancelled():
                        fut.set_exception(ex)
                else:
                    if not fut.cancelled():
                        fut.set_result(data)
            else:
                if not fut.cancelled():
                    fut.set_exception(result)

        AddrInfoRequest(self, host, port, family, type, proto, flags, callback)
        return fut

    cdef _getnameinfo(self, system.sockaddr *addr, int flags):
        cdef NameInfoRequest nr
        fut = self._new_future()

        def callback(result):
            if isinstance(result, tuple):
                fut.set_result(result)
            else:
                fut.set_exception(result)

        nr = NameInfoRequest(self, callback)
        nr.query(addr, flags)
        return fut

    cdef _sock_recv(self, fut, sock, n):
        if UVLOOP_DEBUG:
            if fut.cancelled():
                # Shouldn't happen with _SyncSocketReaderFuture.
                raise RuntimeError(
                    f'_sock_recv is called on a cancelled Future')

            if not self._has_reader(sock):
                raise RuntimeError(
                    f'socket {sock!r} does not have a reader '
                    f'in the _sock_recv callback')

        try:
            data = sock.recv(n)
        except (BlockingIOError, InterruptedError):
            # No need to re-add the reader, let's just wait until
            # the poll handler calls this callback again.
            pass
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            fut.set_exception(exc)
            self._remove_reader(sock)
        else:
            fut.set_result(data)
            self._remove_reader(sock)

    cdef _sock_recv_into(self, fut, sock, buf):
        if UVLOOP_DEBUG:
            if fut.cancelled():
                # Shouldn't happen with _SyncSocketReaderFuture.
                raise RuntimeError(
                    f'_sock_recv_into is called on a cancelled Future')

            if not self._has_reader(sock):
                raise RuntimeError(
                    f'socket {sock!r} does not have a reader '
                    f'in the _sock_recv_into callback')

        try:
            data = sock.recv_into(buf)
        except (BlockingIOError, InterruptedError):
            # No need to re-add the reader, let's just wait until
            # the poll handler calls this callback again.
            pass
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            fut.set_exception(exc)
            self._remove_reader(sock)
        else:
            fut.set_result(data)
            self._remove_reader(sock)

    cdef _sock_sendall(self, fut, sock, data):
        cdef:
            Handle handle
            int n

        if UVLOOP_DEBUG:
            if fut.cancelled():
                # Shouldn't happen with _SyncSocketWriterFuture.
                raise RuntimeError(
                    f'_sock_sendall is called on a cancelled Future')

            if not self._has_writer(sock):
                raise RuntimeError(
                    f'socket {sock!r} does not have a writer '
                    f'in the _sock_sendall callback')

        try:
            n = sock.send(data)
        except (BlockingIOError, InterruptedError):
            # Try next time.
            return
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            fut.set_exception(exc)
            self._remove_writer(sock)
            return

        self._remove_writer(sock)

        if n == len(data):
            fut.set_result(None)
        else:
            if n:
                if not isinstance(data, memoryview):
                    data = memoryview(data)
                data = data[n:]

            handle = new_MethodHandle3(
                self,
                "Loop._sock_sendall",
                <method3_t>self._sock_sendall,
                None,
                self,
                fut, sock, data)

            self._add_writer(sock, handle)

    cdef _sock_accept(self, fut, sock):
        try:
            conn, address = sock.accept()
            conn.setblocking(False)
        except (BlockingIOError, InterruptedError):
            # There is an active reader for _sock_accept, so
            # do nothing, it will be called again.
            pass
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            fut.set_exception(exc)
            self._remove_reader(sock)
        else:
            fut.set_result((conn, address))
            self._remove_reader(sock)

    cdef _sock_connect(self, sock, address):
        cdef:
            Handle handle

        try:
            sock.connect(address)
        except (BlockingIOError, InterruptedError):
            pass
        else:
            return

        fut = _SyncSocketWriterFuture(sock, self)
        handle = new_MethodHandle3(
            self,
            "Loop._sock_connect",
            <method3_t>self._sock_connect_cb,
            None,
            self,
            fut, sock, address)

        self._add_writer(sock, handle)
        return fut

    cdef _sock_connect_cb(self, fut, sock, address):
        if UVLOOP_DEBUG:
            if fut.cancelled():
                # Shouldn't happen with _SyncSocketWriterFuture.
                raise RuntimeError(
                    f'_sock_connect_cb is called on a cancelled Future')

            if not self._has_writer(sock):
                raise RuntimeError(
                    f'socket {sock!r} does not have a writer '
                    f'in the _sock_connect_cb callback')

        try:
            err = sock.getsockopt(uv.SOL_SOCKET, uv.SO_ERROR)
            if err != 0:
                # Jump to any except clause below.
                raise OSError(err, 'Connect call failed %s' % (address,))
        except (BlockingIOError, InterruptedError):
            # socket is still registered, the callback will be retried later
            pass
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            fut.set_exception(exc)
            self._remove_writer(sock)
        else:
            fut.set_result(None)
            self._remove_writer(sock)

    cdef _sock_set_reuseport(self, int fd):
        cdef:
            int err = 0
            int reuseport_flag = 1

        err = system.setsockopt(
            fd,
            uv.SOL_SOCKET,
            SO_REUSEPORT,
            <char*>&reuseport_flag,
            sizeof(reuseport_flag))

        if err < 0:
            raise convert_error(-errno.errno)

    cdef _set_coroutine_debug(self, bint enabled):
        enabled = bool(enabled)
        if self._coroutine_debug_set == enabled:
            return

        if enabled:
            self._coroutine_origin_tracking_saved_depth = (
                sys.get_coroutine_origin_tracking_depth())
            sys.set_coroutine_origin_tracking_depth(
                DEBUG_STACK_DEPTH)
        else:
            sys.set_coroutine_origin_tracking_depth(
                self._coroutine_origin_tracking_saved_depth)

        self._coroutine_debug_set = enabled

    def _get_backend_id(self):
        """This method is used by uvloop tests and is not part of the API."""
        return uv.uv_backend_fd(self.uvloop)

    cdef _print_debug_info(self):
        cdef:
            int err
            uv.uv_rusage_t rusage

        err = uv.uv_getrusage(&rusage)
        if err < 0:
            raise convert_error(err)

        # OS

        print('---- Process info: -----')
        print('Process memory:            {}'.format(rusage.ru_maxrss))
        print('Number of signals:         {}'.format(rusage.ru_nsignals))
        print('')

        # Loop

        print('--- Loop debug info: ---')
        print('Loop time:                 {}'.format(self.time()))
        print('Errors logged:             {}'.format(
            self._debug_exception_handler_cnt))
        print()
        print('Callback handles:          {: <8} | {}'.format(
            self._debug_cb_handles_count,
            self._debug_cb_handles_total))
        print('Timer handles:             {: <8} | {}'.format(
            self._debug_cb_timer_handles_count,
            self._debug_cb_timer_handles_total))
        print()

        print('                        alive  | closed  |')
        print('UVHandles               python | libuv   | total')
        print('                        objs   | handles |')
        print('-------------------------------+---------+---------')
        for name in sorted(self._debug_handles_total):
            print('    {: <18} {: >7} | {: >7} | {: >7}'.format(
                name,
                self._debug_handles_current[name],
                self._debug_handles_closed[name],
                self._debug_handles_total[name]))
        print()

        print('uv_handle_t (current: {}; freed: {}; total: {})'.format(
            self._debug_uv_handles_total - self._debug_uv_handles_freed,
            self._debug_uv_handles_freed,
            self._debug_uv_handles_total))
        print()

        print('--- Streams debug info: ---')
        print('Write errors:              {}'.format(
            self._debug_stream_write_errors_total))
        print('Write without poll:        {}'.format(
            self._debug_stream_write_tries))
        print('Write contexts:            {: <8} | {}'.format(
            self._debug_stream_write_ctx_cnt,
            self._debug_stream_write_ctx_total))
        print('Write failed callbacks:    {}'.format(
            self._debug_stream_write_cb_errors_total))
        print()
        print('Read errors:               {}'.format(
            self._debug_stream_read_errors_total))
        print('Read callbacks:            {}'.format(
            self._debug_stream_read_cb_total))
        print('Read failed callbacks:     {}'.format(
            self._debug_stream_read_cb_errors_total))
        print('Read EOFs:                 {}'.format(
            self._debug_stream_read_eof_total))
        print('Read EOF failed callbacks: {}'.format(
            self._debug_stream_read_eof_cb_errors_total))
        print()
        print('Listen errors:             {}'.format(
            self._debug_stream_listen_errors_total))
        print('Shutdown errors            {}'.format(
            self._debug_stream_shutdown_errors_total))
        print()

        print('--- Polls debug info: ---')
        print('Read events:               {}'.format(
            self._poll_read_events_total))
        print('Read callbacks failed:     {}'.format(
            self._poll_read_cb_errors_total))
        print('Write events:              {}'.format(
            self._poll_write_events_total))
        print('Write callbacks failed:    {}'.format(
            self._poll_write_cb_errors_total))
        print()

        print('--- Sock ops successful on 1st try: ---')
        print('Socket try-writes:         {}'.format(
            self._sock_try_write_total))

        print(flush=True)

    property print_debug_info:
        def __get__(self):
            if UVLOOP_DEBUG:
                return lambda: self._print_debug_info()
            else:
                raise AttributeError('print_debug_info')

    # Public API

    def __repr__(self):
        return '<{}.{} running={} closed={} debug={}>'.format(
            self.__class__.__module__,
            self.__class__.__name__,
            self.is_running(),
            self.is_closed(),
            self.get_debug()
        )

    def call_soon(self, callback, *args, context=None):
        """Arrange for a callback to be called as soon as possible.

        This operates as a FIFO queue: callbacks are called in the
        order in which they are registered.  Each callback will be
        called exactly once.

        Any positional arguments after the callback will be passed to
        the callback when it is called.
        """
        if self._debug == 1:
            self._check_thread()
        if args:
            return self._call_soon(callback, args, context)
        else:
            return self._call_soon(callback, None, context)

    def call_soon_threadsafe(self, callback, *args, context=None):
        """Like call_soon(), but thread-safe."""
        if not args:
            args = None
        cdef Handle handle = new_Handle(self, callback, args, context)
        self._append_ready_handle(handle)  # deque append is atomic
        # libuv async handler is thread-safe while the idle handler is not -
        # we only set the async handler here, which will start the idle handler
        # in _on_wake() from the loop and eventually call the callback.
        self.handler_async.send()
        return handle

    def call_later(self, delay, callback, *args, context=None):
        """Arrange for a callback to be called at a given time.

        Return a Handle: an opaque object with a cancel() method that
        can be used to cancel the call.

        The delay can be an int or float, expressed in seconds.  It is
        always relative to the current time.

        Each callback will be called exactly once.  If two callbacks
        are scheduled for exactly the same time, it undefined which
        will be called first.

        Any positional arguments after the callback will be passed to
        the callback when it is called.
        """
        cdef uint64_t when

        self._check_closed()
        if self._debug == 1:
            self._check_thread()

        if delay < 0:
            delay = 0
        elif delay == py_inf or delay > MAX_SLEEP:
            # ~100 years sounds like a good approximation of
            # infinity for a Python application.
            delay = MAX_SLEEP

        when = <uint64_t>round(delay * 1000)
        if not args:
            args = None
        if when == 0:
            return self._call_soon(callback, args, context)
        else:
            return self._call_later(when, callback, args, context)

    def call_at(self, when, callback, *args, context=None):
        """Like call_later(), but uses an absolute time.

        Absolute time corresponds to the event loop's time() method.
        """
        return self.call_later(
            when - self.time(), callback, *args, context=context)

    def time(self):
        """Return the time according to the event loop's clock.

        This is a float expressed in seconds since an epoch, but the
        epoch, precision, accuracy and drift are unspecified and may
        differ per event loop.
        """
        return self._time() / 1000

    def stop(self):
        """Stop running the event loop.

        Every callback already scheduled will still run.  This simply informs
        run_forever to stop looping after a complete iteration.
        """
        self._call_soon_handle(
            new_MethodHandle1(
                self,
                "Loop._stop",
                <method1_t>self._stop,
                None,
                self,
                None))

    def run_forever(self):
        """Run the event loop until stop() is called."""
        self._check_closed()
        mode = uv.UV_RUN_DEFAULT
        if self._stopping:
            # loop.stop() was called right before loop.run_forever().
            # This is how asyncio loop behaves.
            mode = uv.UV_RUN_NOWAIT
        self._set_coroutine_debug(self._debug)
        old_agen_hooks = sys.get_asyncgen_hooks()
        sys.set_asyncgen_hooks(firstiter=self._asyncgen_firstiter_hook,
                               finalizer=self._asyncgen_finalizer_hook)
        try:
            self._run(mode)
        finally:
            self._set_coroutine_debug(False)
            sys.set_asyncgen_hooks(*old_agen_hooks)

    def close(self):
        """Close the event loop.

        The event loop must not be running.

        This is idempotent and irreversible.

        No other methods should be called after this one.
        """
        self._close()

    def get_debug(self):
        return bool(self._debug)

    def set_debug(self, enabled):
        self._debug = bool(enabled)
        if self.is_running():
             self.call_soon_threadsafe(self._set_coroutine_debug, self._debug)

    def is_running(self):
        """Return whether the event loop is currently running."""
        return bool(self._running)

    def is_closed(self):
        """Returns True if the event loop was closed."""
        return bool(self._closed)

    def create_future(self):
        """Create a Future object attached to the loop."""
        return self._new_future()

    def create_task(self, coro, *, name=None, context=None):
        """Schedule a coroutine object.

        Return a task object.

        If name is not None, task.set_name(name) will be called if the task
        object has the set_name attribute, true for default Task in CPython.

        An optional keyword-only context argument allows specifying a custom
        contextvars.Context for the coro to run in. The current context copy is
        created when no context is provided.
        """
        self._check_closed()
        if PY311:
            if self._task_factory is None:
                task = aio_Task(coro, loop=self, context=context)
            else:
                task = self._task_factory(self, coro, context=context)
        else:
            if context is None:
                if self._task_factory is None:
                    task = aio_Task(coro, loop=self)
                else:
                    task = self._task_factory(self, coro)
            else:
                if self._task_factory is None:
                    task = context.run(aio_Task, coro, self)
                else:
                    task = context.run(self._task_factory, self, coro)

        # copied from asyncio.tasks._set_task_name (bpo-34270)
        if name is not None:
            try:
                set_name = task.set_name
            except AttributeError:
                pass
            else:
                set_name(name)

        return task

    def set_task_factory(self, factory):
        """Set a task factory that will be used by loop.create_task().

        If factory is None the default task factory will be set.

        If factory is a callable, it should have a signature matching
        '(loop, coro)', where 'loop' will be a reference to the active
        event loop, 'coro' will be a coroutine object.  The callable
        must return a Future.
        """
        if factory is not None and not callable(factory):
            raise TypeError('task factory must be a callable or None')
        self._task_factory = factory

    def get_task_factory(self):
        """Return a task factory, or None if the default one is in use."""
        return self._task_factory

    def run_until_complete(self, future):
        """Run until the Future is done.

        If the argument is a coroutine, it is wrapped in a Task.

        WARNING: It would be disastrous to call run_until_complete()
        with the same coroutine twice -- it would wrap it in two
        different Tasks and that can't be good.

        Return the Future's result, or raise its exception.
        """
        self._check_closed()

        new_task = not isfuture(future)
        future = aio_ensure_future(future, loop=self)
        if new_task:
            # An exception is raised if the future didn't complete, so there
            # is no need to log the "destroy pending task" message
            future._log_destroy_pending = False

        def done_cb(fut):
            if not fut.cancelled():
                exc = fut.exception()
                if isinstance(exc, (SystemExit, KeyboardInterrupt)):
                    # Issue #336: run_forever() already finished,
                    # no need to stop it.
                    return
            self.stop()

        future.add_done_callback(done_cb)
        try:
            self.run_forever()
        except BaseException:
            if new_task and future.done() and not future.cancelled():
                # The coroutine raised a BaseException. Consume the exception
                # to not log a warning, the caller doesn't have access to the
                # local task.
                future.exception()
            raise
        finally:
            future.remove_done_callback(done_cb)
        if not future.done():
            raise RuntimeError('Event loop stopped before Future completed.')

        return future.result()

    @cython.iterable_coroutine
    async def getaddrinfo(self, object host, object port, *,
                          int family=0, int type=0, int proto=0, int flags=0):

        addr = __static_getaddrinfo_pyaddr(host, port, family,
                                           type, proto, flags)
        if addr is not None:
            return [addr]

        return await self._getaddrinfo(
            host, port, family, type, proto, flags, 1)

    @cython.iterable_coroutine
    async def getnameinfo(self, sockaddr, int flags=0):
        cdef:
            AddrInfo ai_cnt
            system.addrinfo *ai
            system.sockaddr_in6 *sin6

        if not isinstance(sockaddr, tuple):
            raise TypeError('getnameinfo() argument 1 must be a tuple')

        sl = len(sockaddr)

        if sl < 2 or sl > 4:
            raise ValueError('sockaddr must be a tuple of 2, 3 or 4 values')

        if sl > 2:
            flowinfo = sockaddr[2]
            if flowinfo < 0 or flowinfo > 0xfffff:
                raise OverflowError(
                    'getnameinfo(): flowinfo must be 0-1048575.')
        else:
            flowinfo = 0

        if sl > 3:
            scope_id = sockaddr[3]
            if scope_id < 0 or scope_id > 2 ** 32:
                raise OverflowError(
                    'getsockaddrarg: scope_id must be unsigned 32 bit integer')
        else:
            scope_id = 0

        ai_cnt = await self._getaddrinfo(
            sockaddr[0], sockaddr[1],
            uv.AF_UNSPEC,         # family
            uv.SOCK_DGRAM,        # type
            0,                    # proto
            uv.AI_NUMERICHOST,    # flags
            0)                    # unpack

        ai = ai_cnt.data

        if ai.ai_next:
            raise OSError("sockaddr resolved to multiple addresses")

        if ai.ai_family == uv.AF_INET:
            if sl > 2:
                raise OSError("IPv4 sockaddr must be 2 tuple")
        elif ai.ai_family == uv.AF_INET6:
            # Modify some fields in `ai`
            sin6 = <system.sockaddr_in6*> ai.ai_addr
            sin6.sin6_flowinfo = system.htonl(flowinfo)
            sin6.sin6_scope_id = scope_id

        return await self._getnameinfo(ai.ai_addr, flags)

    @cython.iterable_coroutine
    async def start_tls(self, transport, protocol, sslcontext, *,
                        server_side=False,
                        server_hostname=None,
                        ssl_handshake_timeout=None,
                        ssl_shutdown_timeout=None):
        """Upgrade transport to TLS.

        Return a new transport that *protocol* should start using
        immediately.
        """
        if not isinstance(sslcontext, ssl_SSLContext):
            raise TypeError(
                f'sslcontext is expected to be an instance of ssl.SSLContext, '
                f'got {sslcontext!r}')

        if isinstance(transport, (TCPTransport, UnixTransport)):
            context = (<UVStream>transport).context
        elif isinstance(transport, _SSLProtocolTransport):
            context = (<_SSLProtocolTransport>transport).context
        else:
            raise TypeError(
                f'transport {transport!r} is not supported by start_tls()')

        waiter = self._new_future()
        ssl_protocol = SSLProtocol(
            self, protocol, sslcontext, waiter,
            server_side, server_hostname,
            ssl_handshake_timeout=ssl_handshake_timeout,
            ssl_shutdown_timeout=ssl_shutdown_timeout,
            call_connection_made=False)

        # Pause early so that "ssl_protocol.data_received()" doesn't
        # have a chance to get called before "ssl_protocol.connection_made()".
        transport.pause_reading()

        transport.set_protocol(ssl_protocol)
        conmade_cb = self.call_soon(ssl_protocol.connection_made, transport,
                                    context=context)
        # transport.resume_reading() will use the right context
        # (transport.context) to call e.g. data_received()
        resume_cb = self.call_soon(transport.resume_reading)
        app_transport = ssl_protocol._get_app_transport(context)

        try:
            await waiter
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException:
            app_transport.close()
            conmade_cb.cancel()
            resume_cb.cancel()
            raise

        return app_transport

    @cython.iterable_coroutine
    async def create_server(self, protocol_factory, host=None, port=None,
                            *,
                            int family=uv.AF_UNSPEC,
                            int flags=uv.AI_PASSIVE,
                            sock=None,
                            backlog=100,
                            ssl=None,
                            reuse_address=None,
                            reuse_port=None,
                            ssl_handshake_timeout=None,
                            ssl_shutdown_timeout=None,
                            start_serving=True):
        """A coroutine which creates a TCP server bound to host and port.

        The return value is a Server object which can be used to stop
        the service.

        If host is an empty string or None all interfaces are assumed
        and a list of multiple sockets will be returned (most likely
        one for IPv4 and another one for IPv6). The host parameter can also be
        a sequence (e.g. list) of hosts to bind to.

        family can be set to either AF_INET or AF_INET6 to force the
        socket to use IPv4 or IPv6. If not set it will be determined
        from host (defaults to AF_UNSPEC).

        flags is a bitmask for getaddrinfo().

        sock can optionally be specified in order to use a preexisting
        socket object.

        backlog is the maximum number of queued connections passed to
        listen() (defaults to 100).

        ssl can be set to an SSLContext to enable SSL over the
        accepted connections.

        reuse_address tells the kernel to reuse a local socket in
        TIME_WAIT state, without waiting for its natural timeout to
        expire. If not specified will automatically be set to True on
        UNIX.

        reuse_port tells the kernel to allow this endpoint to be bound to
        the same port as other existing endpoints are bound to, so long as
        they all set this flag when being created. This option is not
        supported on Windows.

        ssl_handshake_timeout is the time in seconds that an SSL server
        will wait for completion of the SSL handshake before aborting the
        connection. Default is 60s.

        ssl_shutdown_timeout is the time in seconds that an SSL server
        will wait for completion of the SSL shutdown before aborting the
        connection. Default is 30s.
        """
        cdef:
            TCPServer tcp
            system.addrinfo *addrinfo
            Server server

        if sock is not None and sock.family == uv.AF_UNIX:
            if host is not None or port is not None:
                raise ValueError(
                    'host/port and sock can not be specified at the same time')
            return await self.create_unix_server(
                protocol_factory, sock=sock, backlog=backlog, ssl=ssl,
                start_serving=start_serving,
                # asyncio won't clean up socket file using create_server() API
                cleanup_socket=False,
            )

        server = Server(self)

        if ssl is not None:
            if not isinstance(ssl, ssl_SSLContext):
                raise TypeError('ssl argument must be an SSLContext or None')
        else:
            if ssl_handshake_timeout is not None:
                raise ValueError(
                    'ssl_handshake_timeout is only meaningful with ssl')
            if ssl_shutdown_timeout is not None:
                raise ValueError(
                    'ssl_shutdown_timeout is only meaningful with ssl')

        if host is not None or port is not None:
            if sock is not None:
                raise ValueError(
                    'host/port and sock can not be specified at the same time')

            if reuse_address is None:
                reuse_address = os_name == 'posix' and sys_platform != 'cygwin'
            reuse_port = bool(reuse_port)
            if reuse_port and not has_SO_REUSEPORT:
                raise ValueError(
                    'reuse_port not supported by socket module')

            if host == '':
                hosts = [None]
            elif (isinstance(host, str) or not isinstance(host, col_Iterable)):
                hosts = [host]
            else:
                hosts = host

            fs = [self._getaddrinfo(host, port, family,
                                    uv.SOCK_STREAM, 0, flags,
                                    0) for host in hosts]

            infos = await aio_gather(*fs)

            completed = False
            sock = None
            try:
                for info in infos:
                    addrinfo = (<AddrInfo>info).data
                    while addrinfo != NULL:
                        if addrinfo.ai_family == uv.AF_UNSPEC:
                            raise RuntimeError('AF_UNSPEC in DNS results')

                        try:
                            sock = socket_socket(addrinfo.ai_family,
                                                 addrinfo.ai_socktype,
                                                 addrinfo.ai_protocol)
                        except socket_error:
                            # Assume it's a bad family/type/protocol
                            # combination.
                            if self._debug:
                                aio_logger.warning(
                                    'create_server() failed to create '
                                    'socket.socket(%r, %r, %r)',
                                    addrinfo.ai_family,
                                    addrinfo.ai_socktype,
                                    addrinfo.ai_protocol, exc_info=True)
                            addrinfo = addrinfo.ai_next
                            continue

                        if reuse_address:
                            sock.setsockopt(uv.SOL_SOCKET, uv.SO_REUSEADDR, 1)
                        if reuse_port:
                            sock.setsockopt(uv.SOL_SOCKET, SO_REUSEPORT, 1)
                        # Disable IPv4/IPv6 dual stack support (enabled by
                        # default on Linux) which makes a single socket
                        # listen on both address families.
                        if (addrinfo.ai_family == uv.AF_INET6 and
                                has_IPV6_V6ONLY):
                            sock.setsockopt(uv.IPPROTO_IPV6, IPV6_V6ONLY, 1)

                        pyaddr = __convert_sockaddr_to_pyaddr(addrinfo.ai_addr)
                        try:
                            sock.bind(pyaddr)
                        except OSError as err:
                            raise OSError(
                                err.errno, 'error while attempting '
                                'to bind on address %r: %s'
                                % (pyaddr, err.strerror.lower())) from None

                        tcp = TCPServer.new(self, protocol_factory, server,
                                            uv.AF_UNSPEC, backlog,
                                            ssl, ssl_handshake_timeout,
                                            ssl_shutdown_timeout)

                        try:
                            tcp._open(sock.fileno())
                        except (KeyboardInterrupt, SystemExit):
                            raise
                        except BaseException:
                            tcp._close()
                            raise

                        server._add_server(tcp)
                        sock.detach()
                        sock = None

                        addrinfo = addrinfo.ai_next

                completed = True
            finally:
                if not completed:
                    if sock is not None:
                        sock.close()
                    server.close()
        else:
            if sock is None:
                raise ValueError('Neither host/port nor sock were specified')
            if not _is_sock_stream(sock.type):
                raise ValueError(
                    'A Stream Socket was expected, got {!r}'.format(sock))

            # libuv will set the socket to non-blocking mode, but
            # we want Python socket object to notice that.
            sock.setblocking(False)

            tcp = TCPServer.new(self, protocol_factory, server,
                                uv.AF_UNSPEC, backlog,
                                ssl, ssl_handshake_timeout,
                                ssl_shutdown_timeout)

            try:
                tcp._open(sock.fileno())
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                tcp._close()
                raise

            tcp._attach_fileobj(sock)
            server._add_server(tcp)

        if start_serving:
            server._start_serving()

        server._ref()
        return server

    @cython.iterable_coroutine
    async def create_connection(self, protocol_factory, host=None, port=None,
                                *,
                                ssl=None,
                                family=0, proto=0, flags=0, sock=None,
                                local_addr=None, server_hostname=None,
                                ssl_handshake_timeout=None,
                                ssl_shutdown_timeout=None):
        """Connect to a TCP server.

        Create a streaming transport connection to a given Internet host and
        port: socket family AF_INET or socket.AF_INET6 depending on host (or
        family if specified), socket type SOCK_STREAM. protocol_factory must be
        a callable returning a protocol instance.

        This method is a coroutine which will try to establish the connection
        in the background.  When successful, the coroutine returns a
        (transport, protocol) pair.
        """
        cdef:
            AddrInfo ai_local = None
            AddrInfo ai_remote
            TCPTransport tr

            system.addrinfo *rai = NULL
            system.addrinfo *lai = NULL

            system.addrinfo *rai_iter = NULL
            system.addrinfo *lai_iter = NULL

            system.addrinfo rai_static
            system.sockaddr_storage rai_addr_static
            system.addrinfo lai_static
            system.sockaddr_storage lai_addr_static

            object app_protocol
            object app_transport
            object protocol
            object ssl_waiter

        if sock is not None and sock.family == uv.AF_UNIX:
            if host is not None or port is not None:
                raise ValueError(
                    'host/port and sock can not be specified at the same time')
            return await self.create_unix_connection(
                protocol_factory, None,
                sock=sock, ssl=ssl, server_hostname=server_hostname)

        app_protocol = protocol = protocol_factory()
        ssl_waiter = None
        context = Context_CopyCurrent()
        if ssl:
            if server_hostname is None:
                if not host:
                    raise ValueError('You must set server_hostname '
                                     'when using ssl without a host')
                server_hostname = host

            ssl_waiter = self._new_future()
            sslcontext = None if isinstance(ssl, bool) else ssl
            protocol = SSLProtocol(
                self, app_protocol, sslcontext, ssl_waiter,
                False, server_hostname,
                ssl_handshake_timeout=ssl_handshake_timeout,
                ssl_shutdown_timeout=ssl_shutdown_timeout)
        else:
            if server_hostname is not None:
                raise ValueError('server_hostname is only meaningful with ssl')
            if ssl_handshake_timeout is not None:
                raise ValueError(
                    'ssl_handshake_timeout is only meaningful with ssl')
            if ssl_shutdown_timeout is not None:
                raise ValueError(
                    'ssl_shutdown_timeout is only meaningful with ssl')

        if host is not None or port is not None:
            if sock is not None:
                raise ValueError(
                    'host/port and sock can not be specified at the same time')

            fs = []
            f1 = f2 = None

            addr = __static_getaddrinfo(
                host, port, family, uv.SOCK_STREAM,
                proto, <system.sockaddr*>&rai_addr_static)

            if addr is None:
                f1 = self._getaddrinfo(
                    host, port, family,
                    uv.SOCK_STREAM, proto, flags,
                    0)  # 0 == don't unpack

                fs.append(f1)
            else:
                rai_static.ai_addr = <system.sockaddr*>&rai_addr_static
                rai_static.ai_next = NULL
                rai = &rai_static

            if local_addr is not None:
                if not isinstance(local_addr, (tuple, list)) or \
                        len(local_addr) != 2:
                    raise ValueError(
                        'local_addr must be a tuple of host and port')

                addr = __static_getaddrinfo(
                    local_addr[0], local_addr[1],
                    family, uv.SOCK_STREAM,
                    proto, <system.sockaddr*>&lai_addr_static)
                if addr is None:
                    f2 = self._getaddrinfo(
                        local_addr[0], local_addr[1], family,
                        uv.SOCK_STREAM, proto, flags,
                        0)  # 0 == don't unpack

                    fs.append(f2)
                else:
                    lai_static.ai_addr = <system.sockaddr*>&lai_addr_static
                    lai_static.ai_next = NULL
                    lai = &lai_static

            if len(fs):
                await aio_wait(fs)

            if rai is NULL:
                ai_remote = f1.result()
                if ai_remote.data is NULL:
                    raise OSError('getaddrinfo() returned empty list')
                rai = ai_remote.data

            if lai is NULL and f2 is not None:
                ai_local = f2.result()
                if ai_local.data is NULL:
                    raise OSError(
                        'getaddrinfo() returned empty list for local_addr')
                lai = ai_local.data

            exceptions = []
            rai_iter = rai
            while rai_iter is not NULL:
                tr = None
                try:
                    waiter = self._new_future()
                    tr = TCPTransport.new(self, protocol, None, waiter,
                                          context)

                    if lai is not NULL:
                        lai_iter = lai
                        while lai_iter is not NULL:
                            try:
                                tr.bind(lai_iter.ai_addr)
                                break
                            except OSError as exc:
                                exceptions.append(exc)
                            lai_iter = lai_iter.ai_next
                        else:
                            tr._close()
                            tr = None

                            rai_iter = rai_iter.ai_next
                            continue

                    tr.connect(rai_iter.ai_addr)
                    await waiter

                except OSError as exc:
                    if tr is not None:
                        tr._close()
                        tr = None
                    exceptions.append(exc)
                except (KeyboardInterrupt, SystemExit):
                    raise
                except BaseException:
                    if tr is not None:
                        tr._close()
                        tr = None
                    raise
                else:
                    break

                rai_iter = rai_iter.ai_next

            else:
                # If they all have the same str(), raise one.
                model = str(exceptions[0])
                if all(str(exc) == model for exc in exceptions):
                    raise exceptions[0]
                # Raise a combined exception so the user can see all
                # the various error messages.
                raise OSError('Multiple exceptions: {}'.format(
                    ', '.join(str(exc) for exc in exceptions)))
        else:
            if sock is None:
                raise ValueError(
                    'host and port was not specified and no sock specified')
            if not _is_sock_stream(sock.type):
                raise ValueError(
                    'A Stream Socket was expected, got {!r}'.format(sock))

            # libuv will set the socket to non-blocking mode, but
            # we want Python socket object to notice that.
            sock.setblocking(False)

            waiter = self._new_future()
            tr = TCPTransport.new(self, protocol, None, waiter, context)
            try:
                # libuv will make socket non-blocking
                tr._open(sock.fileno())
                tr._init_protocol()
                await waiter
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                # It's OK to call `_close()` here, as opposed to
                # `_force_close()` or `close()` as we want to terminate the
                # transport immediately.  The `waiter` can only be waken
                # up in `Transport._call_connection_made()`, and calling
                # `_close()` before it is fine.
                tr._close()
                raise

            tr._attach_fileobj(sock)

        if ssl:
            app_transport = protocol._get_app_transport(context)
            try:
                await ssl_waiter
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                app_transport.close()
                raise
            return app_transport, app_protocol
        else:
            return tr, protocol

    @cython.iterable_coroutine
    async def create_unix_server(self, protocol_factory, path=None,
                                 *, backlog=100, sock=None, ssl=None,
                                 ssl_handshake_timeout=None,
                                 ssl_shutdown_timeout=None,
                                 start_serving=True, cleanup_socket=PY313):
        """A coroutine which creates a UNIX Domain Socket server.

        The return value is a Server object, which can be used to stop
        the service.

        path is a str, representing a file systsem path to bind the
        server socket to.

        sock can optionally be specified in order to use a preexisting
        socket object.

        backlog is the maximum number of queued connections passed to
        listen() (defaults to 100).

        ssl can be set to an SSLContext to enable SSL over the
        accepted connections.

        ssl_handshake_timeout is the time in seconds that an SSL server
        will wait for completion of the SSL handshake before aborting the
        connection. Default is 60s.

        ssl_shutdown_timeout is the time in seconds that an SSL server
        will wait for completion of the SSL shutdown before aborting the
        connection. Default is 30s.

        If *cleanup_socket* is true then the Unix socket will automatically
        be removed from the filesystem when the server is closed, unless the
        socket has been replaced after the server has been created.
        This defaults to True on Python 3.13 and above, or False otherwise.
        """
        cdef:
            UnixServer pipe
            Server server = Server(self)

        if ssl is not None:
            if not isinstance(ssl, ssl_SSLContext):
                raise TypeError('ssl argument must be an SSLContext or None')
        else:
            if ssl_handshake_timeout is not None:
                raise ValueError(
                    'ssl_handshake_timeout is only meaningful with ssl')
            if ssl_shutdown_timeout is not None:
                raise ValueError(
                    'ssl_shutdown_timeout is only meaningful with ssl')

        if path is not None:
            if sock is not None:
                raise ValueError(
                    'path and sock can not be specified at the same time')
            orig_path = path

            path = os_fspath(path)

            if isinstance(path, str):
                path = PyUnicode_EncodeFSDefault(path)

            # Check for abstract socket.
            if path[0] != 0:
                try:
                    if stat_S_ISSOCK(os_stat(path).st_mode):
                        os_remove(path)
                except FileNotFoundError:
                    pass
                except OSError as err:
                    # Directory may have permissions only to create socket.
                    aio_logger.error(
                        'Unable to check or remove stale UNIX socket %r: %r',
                        orig_path, err)

            # We use Python sockets to create a UNIX server socket because
            # when UNIX sockets are created by libuv, libuv removes the path
            # they were bound to.  This is different from asyncio, which
            # doesn't cleanup the socket path.
            sock = socket_socket(uv.AF_UNIX)

            try:
                sock.bind(path)
            except OSError as exc:
                sock.close()
                if exc.errno == errno.EADDRINUSE:
                    # Let's improve the error message by adding
                    # with what exact address it occurs.
                    msg = 'Address {!r} is already in use'.format(orig_path)
                    raise OSError(errno.EADDRINUSE, msg) from None
                else:
                    raise
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                sock.close()
                raise

        else:
            if sock is None:
                raise ValueError(
                    'path was not specified, and no sock specified')

            if sock.family != uv.AF_UNIX or not _is_sock_stream(sock.type):
                raise ValueError(
                    'A UNIX Domain Stream Socket was expected, got {!r}'
                    .format(sock))

            # libuv will set the socket to non-blocking mode, but
            # we want Python socket object to notice that.
            sock.setblocking(False)

        if cleanup_socket:
            path = sock.getsockname()
            # Check for abstract socket. `str` and `bytes` paths are supported.
            if path[0] not in (0, '\x00'):
                try:
                    self._unix_server_sockets[sock] = os_stat(path).st_ino
                except FileNotFoundError:
                    pass

        pipe = UnixServer.new(
            self, protocol_factory, server, backlog,
            ssl, ssl_handshake_timeout, ssl_shutdown_timeout)

        try:
            pipe._open(sock.fileno())
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException:
            pipe._close()
            sock.close()
            raise

        pipe._attach_fileobj(sock)
        server._add_server(pipe)

        if start_serving:
            server._start_serving()

        return server

    @cython.iterable_coroutine
    async def create_unix_connection(self, protocol_factory, path=None, *,
                                     ssl=None, sock=None,
                                     server_hostname=None,
                                     ssl_handshake_timeout=None,
                                     ssl_shutdown_timeout=None):

        cdef:
            UnixTransport tr
            object app_protocol
            object app_transport
            object protocol
            object ssl_waiter

        app_protocol = protocol = protocol_factory()
        ssl_waiter = None
        context = Context_CopyCurrent()
        if ssl:
            if server_hostname is None:
                raise ValueError('You must set server_hostname '
                                 'when using ssl without a host')

            ssl_waiter = self._new_future()
            sslcontext = None if isinstance(ssl, bool) else ssl
            protocol = SSLProtocol(
                self, app_protocol, sslcontext, ssl_waiter,
                False, server_hostname,
                ssl_handshake_timeout=ssl_handshake_timeout,
                ssl_shutdown_timeout=ssl_shutdown_timeout)
        else:
            if server_hostname is not None:
                raise ValueError('server_hostname is only meaningful with ssl')
            if ssl_handshake_timeout is not None:
                raise ValueError(
                    'ssl_handshake_timeout is only meaningful with ssl')
            if ssl_shutdown_timeout is not None:
                raise ValueError(
                    'ssl_shutdown_timeout is only meaningful with ssl')

        if path is not None:
            if sock is not None:
                raise ValueError(
                    'path and sock can not be specified at the same time')

            path = os_fspath(path)

            if isinstance(path, str):
                path = PyUnicode_EncodeFSDefault(path)

            waiter = self._new_future()
            tr = UnixTransport.new(self, protocol, None, waiter, context)
            tr.connect(path)
            try:
                await waiter
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                tr._close()
                raise

        else:
            if sock is None:
                raise ValueError('no path and sock were specified')

            if sock.family != uv.AF_UNIX or not _is_sock_stream(sock.type):
                raise ValueError(
                    'A UNIX Domain Stream Socket was expected, got {!r}'
                    .format(sock))

            # libuv will set the socket to non-blocking mode, but
            # we want Python socket object to notice that.
            sock.setblocking(False)

            waiter = self._new_future()
            tr = UnixTransport.new(self, protocol, None, waiter, context)
            try:
                tr._open(sock.fileno())
                tr._init_protocol()
                await waiter
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                tr._close()
                raise

            tr._attach_fileobj(sock)

        if ssl:
            app_transport = protocol._get_app_transport(Context_CopyCurrent())
            try:
                await ssl_waiter
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                app_transport.close()
                raise
            return app_transport, app_protocol
        else:
            return tr, protocol

    def default_exception_handler(self, context):
        """Default exception handler.

        This is called when an exception occurs and no exception
        handler is set, and can be called by a custom exception
        handler that wants to defer to the default behavior.

        The context parameter has the same meaning as in
        `call_exception_handler()`.
        """
        message = context.get('message')
        if not message:
            message = 'Unhandled exception in event loop'

        exception = context.get('exception')
        if exception is not None:
            exc_info = (type(exception), exception, exception.__traceback__)
        else:
            exc_info = False

        log_lines = [message]
        for key in sorted(context):
            if key in {'message', 'exception'}:
                continue
            value = context[key]
            if key == 'source_traceback':
                tb = ''.join(tb_format_list(value))
                value = 'Object created at (most recent call last):\n'
                value += tb.rstrip()
            else:
                try:
                    value = repr(value)
                except (KeyboardInterrupt, SystemExit):
                    raise
                except BaseException as ex:
                    value = ('Exception in __repr__ {!r}; '
                             'value type: {!r}'.format(ex, type(value)))
            log_lines.append('{}: {}'.format(key, value))

        aio_logger.error('\n'.join(log_lines), exc_info=exc_info)

    def get_exception_handler(self):
        """Return an exception handler, or None if the default one is in use.
        """
        return self._exception_handler

    def set_exception_handler(self, handler):
        """Set handler as the new event loop exception handler.

        If handler is None, the default exception handler will
        be set.

        If handler is a callable object, it should have a
        signature matching '(loop, context)', where 'loop'
        will be a reference to the active event loop, 'context'
        will be a dict object (see `call_exception_handler()`
        documentation for details about context).
        """
        if handler is not None and not callable(handler):
            raise TypeError('A callable object or None is expected, '
                            'got {!r}'.format(handler))
        self._exception_handler = handler

    def call_exception_handler(self, context):
        """Call the current event loop's exception handler.

        The context argument is a dict containing the following keys:

        - 'message': Error message;
        - 'exception' (optional): Exception object;
        - 'future' (optional): Future instance;
        - 'handle' (optional): Handle instance;
        - 'protocol' (optional): Protocol instance;
        - 'transport' (optional): Transport instance;
        - 'socket' (optional): Socket instance.

        New keys maybe introduced in the future.

        Note: do not overload this method in an event loop subclass.
        For custom exception handling, use the
        `set_exception_handler()` method.
        """
        if UVLOOP_DEBUG:
            self._debug_exception_handler_cnt += 1

        if self._exception_handler is None:
            try:
                self.default_exception_handler(context)
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                # Second protection layer for unexpected errors
                # in the default implementation, as well as for subclassed
                # event loops with overloaded "default_exception_handler".
                aio_logger.error('Exception in default exception handler',
                                 exc_info=True)
        else:
            try:
                self._exception_handler(self, context)
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as exc:
                # Exception in the user set custom exception handler.
                try:
                    # Let's try default handler.
                    self.default_exception_handler({
                        'message': 'Unhandled error in exception handler',
                        'exception': exc,
                        'context': context,
                    })
                except (KeyboardInterrupt, SystemExit):
                    raise
                except BaseException:
                    # Guard 'default_exception_handler' in case it is
                    # overloaded.
                    aio_logger.error('Exception in default exception handler '
                                     'while handling an unexpected error '
                                     'in custom exception handler',
                                     exc_info=True)

    def add_reader(self, fileobj, callback, *args):
        """Add a reader callback."""
        if len(args) == 0:
            args = None
        self._add_reader(fileobj, new_Handle(self, callback, args, None))

    def remove_reader(self, fileobj):
        """Remove a reader callback."""
        self._remove_reader(fileobj)

    def add_writer(self, fileobj, callback, *args):
        """Add a writer callback.."""
        if len(args) == 0:
            args = None
        self._add_writer(fileobj, new_Handle(self, callback, args, None))

    def remove_writer(self, fileobj):
        """Remove a writer callback."""
        self._remove_writer(fileobj)

    @cython.iterable_coroutine
    async def sock_recv(self, sock, n):
        """Receive data from the socket.

        The return value is a bytes object representing the data received.
        The maximum amount of data to be received at once is specified by
        nbytes.

        This method is a coroutine.
        """
        cdef:
            Handle handle

        if self._debug and sock.gettimeout() != 0:
            raise ValueError("the socket must be non-blocking")

        fut = _SyncSocketReaderFuture(sock, self)
        handle = new_MethodHandle3(
            self,
            "Loop._sock_recv",
            <method3_t>self._sock_recv,
            None,
            self,
            fut, sock, n)

        self._add_reader(sock, handle)
        return await fut

    @cython.iterable_coroutine
    async def sock_recv_into(self, sock, buf):
        """Receive data from the socket.

        The received data is written into *buf* (a writable buffer).
        The return value is the number of bytes written.

        This method is a coroutine.
        """
        cdef:
            Handle handle

        if self._debug and sock.gettimeout() != 0:
            raise ValueError("the socket must be non-blocking")

        fut = _SyncSocketReaderFuture(sock, self)
        handle = new_MethodHandle3(
            self,
            "Loop._sock_recv_into",
            <method3_t>self._sock_recv_into,
            None,
            self,
            fut, sock, buf)

        self._add_reader(sock, handle)
        return await fut

    @cython.iterable_coroutine
    async def sock_sendall(self, sock, data):
        """Send data to the socket.

        The socket must be connected to a remote socket. This method continues
        to send data from data until either all data has been sent or an
        error occurs. None is returned on success. On error, an exception is
        raised, and there is no way to determine how much data, if any, was
        successfully processed by the receiving end of the connection.

        This method is a coroutine.
        """
        cdef:
            Handle handle
            ssize_t n

        if self._debug and sock.gettimeout() != 0:
            raise ValueError("the socket must be non-blocking")

        if not data:
            return

        socket_inc_io_ref(sock)
        try:
            try:
                n = sock.send(data)
            except (BlockingIOError, InterruptedError):
                pass
            else:
                if UVLOOP_DEBUG:
                    # This can be a partial success, i.e. only part
                    # of the data was sent
                    self._sock_try_write_total += 1

                if n == len(data):
                    return
                if not isinstance(data, memoryview):
                    data = memoryview(data)
                data = data[n:]

            fut = _SyncSocketWriterFuture(sock, self)
            handle = new_MethodHandle3(
                self,
                "Loop._sock_sendall",
                <method3_t>self._sock_sendall,
                None,
                self,
                fut, sock, data)

            self._add_writer(sock, handle)
            return await fut
        finally:
            socket_dec_io_ref(sock)

    @cython.iterable_coroutine
    async def sock_accept(self, sock):
        """Accept a connection.

        The socket must be bound to an address and listening for connections.
        The return value is a pair (conn, address) where conn is a new socket
        object usable to send and receive data on the connection, and address
        is the address bound to the socket on the other end of the connection.

        This method is a coroutine.
        """
        cdef:
            Handle handle

        if self._debug and sock.gettimeout() != 0:
            raise ValueError("the socket must be non-blocking")

        fut = _SyncSocketReaderFuture(sock, self)
        handle = new_MethodHandle2(
            self,
            "Loop._sock_accept",
            <method2_t>self._sock_accept,
            None,
            self,
            fut, sock)

        self._add_reader(sock, handle)
        return await fut

    @cython.iterable_coroutine
    async def sock_connect(self, sock, address):
        """Connect to a remote socket at address.

        This method is a coroutine.
        """
        if self._debug and sock.gettimeout() != 0:
            raise ValueError("the socket must be non-blocking")

        socket_inc_io_ref(sock)
        try:
            if sock.family == uv.AF_UNIX:
                fut = self._sock_connect(sock, address)
            else:
                addrs = await self.getaddrinfo(
                    *address[:2], family=sock.family)

                _, _, _, _, address = addrs[0]
                fut = self._sock_connect(sock, address)
            if fut is not None:
                await fut
        finally:
            socket_dec_io_ref(sock)

    @cython.iterable_coroutine
    async def sock_recvfrom(self, sock, bufsize):
        raise NotImplementedError

    @cython.iterable_coroutine
    async def sock_recvfrom_into(self, sock, buf, nbytes=0):
        raise NotImplementedError

    @cython.iterable_coroutine
    async def sock_sendto(self, sock, data, address):
        raise NotImplementedError

    @cython.iterable_coroutine
    async def connect_accepted_socket(self, protocol_factory, sock, *,
                                      ssl=None,
                                      ssl_handshake_timeout=None,
                                      ssl_shutdown_timeout=None):
        """Handle an accepted connection.

        This is used by servers that accept connections outside of
        asyncio but that use asyncio to handle connections.

        This method is a coroutine.  When completed, the coroutine
        returns a (transport, protocol) pair.
        """

        cdef:
            UVStream transport = None

        if ssl is not None:
            if not isinstance(ssl, ssl_SSLContext):
                raise TypeError('ssl argument must be an SSLContext or None')
        else:
            if ssl_handshake_timeout is not None:
                raise ValueError(
                    'ssl_handshake_timeout is only meaningful with ssl')
            if ssl_shutdown_timeout is not None:
                raise ValueError(
                    'ssl_shutdown_timeout is only meaningful with ssl')

        if not _is_sock_stream(sock.type):
            raise ValueError(
                'A Stream Socket was expected, got {!r}'.format(sock))

        app_protocol = protocol_factory()
        waiter = self._new_future()
        transport_waiter = None
        context = Context_CopyCurrent()

        if ssl is None:
            protocol = app_protocol
            transport_waiter = waiter
        else:
            protocol = SSLProtocol(
                self, app_protocol, ssl, waiter,
                server_side=True,
                server_hostname=None,
                ssl_handshake_timeout=ssl_handshake_timeout,
                ssl_shutdown_timeout=ssl_shutdown_timeout)
            transport_waiter = None

        if sock.family == uv.AF_UNIX:
            transport = <UVStream>UnixTransport.new(
                self, protocol, None, transport_waiter, context)
        elif sock.family in (uv.AF_INET, uv.AF_INET6):
            transport = <UVStream>TCPTransport.new(
                self, protocol, None, transport_waiter, context)

        if transport is None:
            raise ValueError(
                'invalid socket family, expected AF_UNIX, AF_INET or AF_INET6')

        transport._open(sock.fileno())
        transport._init_protocol()
        transport._attach_fileobj(sock)

        if ssl:
            app_transport = protocol._get_app_transport(context)
            try:
                await waiter
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                app_transport.close()
                raise
            return app_transport, protocol
        else:
            try:
                await waiter
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:
                transport._close()
                raise
            return transport, protocol

    def run_in_executor(self, executor, func, *args):
        if aio_iscoroutine(func) or aio_iscoroutinefunction(func):
            raise TypeError("coroutines cannot be used with run_in_executor()")

        self._check_closed()

        if executor is None:
            executor = self._default_executor
            # Only check when the default executor is being used
            self._check_default_executor()
            if executor is None:
                executor = cc_ThreadPoolExecutor()
                self._default_executor = executor

        return aio_wrap_future(executor.submit(func, *args), loop=self)

    def set_default_executor(self, executor):
        self._default_executor = executor

    @cython.iterable_coroutine
    async def __subprocess_run(self, protocol_factory, args,
                               stdin=subprocess_PIPE,
                               stdout=subprocess_PIPE,
                               stderr=subprocess_PIPE,
                               universal_newlines=False,
                               shell=True,
                               bufsize=0,
                               preexec_fn=None,
                               close_fds=None,
                               cwd=None,
                               env=None,
                               startupinfo=None,
                               creationflags=0,
                               restore_signals=True,
                               start_new_session=False,
                               executable=None,
                               pass_fds=(),
                               **kwargs):

        # TODO: Implement close_fds (might not be very important in
        # Python 3.5, since all FDs aren't inheritable by default.)

        cdef:
            int debug_flags = 0

        if universal_newlines:
            raise ValueError("universal_newlines must be False")
        if bufsize != 0:
            raise ValueError("bufsize must be 0")
        if startupinfo is not None:
            raise ValueError('startupinfo is not supported')
        if creationflags != 0:
            raise ValueError('creationflags is not supported')

        if executable is not None:
            args[0] = executable

        # For tests only! Do not use in your code. Ever.
        if kwargs.pop("__uvloop_sleep_after_fork", False):
            debug_flags |= __PROCESS_DEBUG_SLEEP_AFTER_FORK
        if kwargs:
            raise ValueError(
                'unexpected kwargs: {}'.format(', '.join(kwargs.keys())))

        waiter = self._new_future()
        protocol = protocol_factory()
        proc = UVProcessTransport.new(self, protocol,
                                      args, env, cwd, start_new_session,
                                      stdin, stdout, stderr, pass_fds,
                                      waiter,
                                      debug_flags,
                                      preexec_fn,
                                      restore_signals)

        try:
            await waiter
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException:
            proc.close()
            raise

        return proc, protocol

    @cython.iterable_coroutine
    async def subprocess_shell(self, protocol_factory, cmd, *,
                               shell=True,
                               **kwargs):

        if not shell:
            raise ValueError("shell must be True")

        args = [cmd]
        if shell:
            args = [b'/bin/sh', b'-c'] + args

        return await self.__subprocess_run(protocol_factory, args, shell=True,
                                           **kwargs)

    @cython.iterable_coroutine
    async def subprocess_exec(self, protocol_factory, program, *args,
                              shell=False, **kwargs):

        if shell:
            raise ValueError("shell must be False")

        args = list((program,) + args)

        return await self.__subprocess_run(protocol_factory, args, shell=False,
                                           **kwargs)

    @cython.iterable_coroutine
    async def connect_read_pipe(self, proto_factory, pipe):
        """Register read pipe in event loop. Set the pipe to non-blocking mode.

        protocol_factory should instantiate object with Protocol interface.
        pipe is a file-like object.
        Return pair (transport, protocol), where transport supports the
        ReadTransport interface."""
        cdef:
            ReadUnixTransport transp

        waiter = self._new_future()
        proto = proto_factory()
        transp = ReadUnixTransport.new(self, proto, None, waiter)
        transp._add_extra_info('pipe', pipe)
        try:
            transp._open(pipe.fileno())
            transp._init_protocol()
            await waiter
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException:
            transp._close()
            raise
        transp._attach_fileobj(pipe)
        return transp, proto

    @cython.iterable_coroutine
    async def connect_write_pipe(self, proto_factory, pipe):
        """Register write pipe in event loop.

        protocol_factory should instantiate object with BaseProtocol interface.
        Pipe is file-like object already switched to nonblocking.
        Return pair (transport, protocol), where transport support
        WriteTransport interface."""
        cdef:
            WriteUnixTransport transp

        waiter = self._new_future()
        proto = proto_factory()
        transp = WriteUnixTransport.new(self, proto, None, waiter)
        transp._add_extra_info('pipe', pipe)
        try:
            transp._open(pipe.fileno())
            transp._init_protocol()
            await waiter
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException:
            transp._close()
            raise
        transp._attach_fileobj(pipe)
        return transp, proto

    def add_signal_handler(self, sig, callback, *args):
        """Add a handler for a signal.  UNIX only.

        Raise ValueError if the signal number is invalid or uncatchable.
        Raise RuntimeError if there is a problem setting up the handler.
        """
        cdef:
            Handle h

        if not self._is_main_thread():
            raise ValueError(
                'add_signal_handler() can only be called from '
                'the main thread')

        if (aio_iscoroutine(callback)
                or aio_iscoroutinefunction(callback)):
            raise TypeError(
                "coroutines cannot be used with add_signal_handler()")

        if sig == uv.SIGCHLD:
            if (hasattr(callback, '__self__') and
                    isinstance(callback.__self__, aio_AbstractChildWatcher)):

                warnings_warn(
                    "!!! asyncio is trying to install its ChildWatcher for "
                    "SIGCHLD signal !!!\n\nThis is probably because a uvloop "
                    "instance is used with asyncio.set_event_loop(). "
                    "The correct way to use uvloop is to install its policy: "
                    "`asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())`"
                    "\n\n", RuntimeWarning, source=self)

                # TODO: ideally we should always raise an error here,
                # but that would be a backwards incompatible change,
                # because we recommended using "asyncio.set_event_loop()"
                # in our README.  Need to start a deprecation period
                # at some point to turn this warning into an error.
                return

            raise RuntimeError(
                'cannot add a signal handler for SIGCHLD: it is used '
                'by the event loop to track subprocesses')

        self._check_signal(sig)
        self._check_closed()

        h = new_Handle(self, callback, args or None, None)
        self._signal_handlers[sig] = h

        try:
            # Register a dummy signal handler to ask Python to write the signal
            # number in the wakeup file descriptor.
            signal_signal(sig, self.__sighandler)

            # Set SA_RESTART to limit EINTR occurrences.
            signal_siginterrupt(sig, False)
        except OSError as exc:
            del self._signal_handlers[sig]
            if not self._signal_handlers:
                try:
                    signal_set_wakeup_fd(-1)
                except (ValueError, OSError) as nexc:
                    aio_logger.info('set_wakeup_fd(-1) failed: %s', nexc)

            if exc.errno == errno_EINVAL:
                raise RuntimeError('sig {} cannot be caught'.format(sig))
            else:
                raise

    def remove_signal_handler(self, sig):
        """Remove a handler for a signal.  UNIX only.

        Return True if a signal handler was removed, False if not.
        """

        if not self._is_main_thread():
            raise ValueError(
                'remove_signal_handler() can only be called from '
                'the main thread')

        self._check_signal(sig)

        if not self._listening_signals:
            return False

        try:
            del self._signal_handlers[sig]
        except KeyError:
            return False

        if sig == uv.SIGINT:
            handler = signal_default_int_handler
        else:
            handler = signal_SIG_DFL

        try:
            signal_signal(sig, handler)
        except OSError as exc:
            if exc.errno == errno_EINVAL:
                raise RuntimeError('sig {} cannot be caught'.format(sig))
            else:
                raise

        return True

    @cython.iterable_coroutine
    async def create_datagram_endpoint(self, protocol_factory,
                                       local_addr=None, remote_addr=None, *,
                                       family=0, proto=0, flags=0,
                                       reuse_address=_unset, reuse_port=None,
                                       allow_broadcast=None, sock=None):
        """A coroutine which creates a datagram endpoint.

        This method will try to establish the endpoint in the background.
        When successful, the coroutine returns a (transport, protocol) pair.

        protocol_factory must be a callable returning a protocol instance.

        socket family AF_INET or socket.AF_INET6 depending on host (or
        family if specified), socket type SOCK_DGRAM.

        reuse_port tells the kernel to allow this endpoint to be bound to
        the same port as other existing endpoints are bound to, so long as
        they all set this flag when being created. This option is not
        supported on Windows and some UNIX's. If the
        :py:data:`~socket.SO_REUSEPORT` constant is not defined then this
        capability is unsupported.

        allow_broadcast tells the kernel to allow this endpoint to send
        messages to the broadcast address.

        sock can optionally be specified in order to use a preexisting
        socket object.
        """
        cdef:
            UDPTransport udp = None
            system.addrinfo * lai
            system.addrinfo * rai

        if sock is not None:
            if not _is_sock_dgram(sock.type):
                raise ValueError(
                    'A UDP Socket was expected, got {!r}'.format(sock))
            if (local_addr or remote_addr or
                    family or proto or flags or
                    reuse_port or allow_broadcast):
                # show the problematic kwargs in exception msg
                opts = dict(local_addr=local_addr, remote_addr=remote_addr,
                            family=family, proto=proto, flags=flags,
                            reuse_address=reuse_address, reuse_port=reuse_port,
                            allow_broadcast=allow_broadcast)
                problems = ', '.join(
                    '{}={}'.format(k, v) for k, v in opts.items() if v)
                raise ValueError(
                    'socket modifier keyword arguments can not be used '
                    'when sock is specified. ({})'.format(problems))
            sock.setblocking(False)
            udp = UDPTransport.__new__(UDPTransport)
            udp._init(self, uv.AF_UNSPEC)
            udp.open(sock.family, sock.fileno())
            udp._attach_fileobj(sock)
        else:
            if reuse_address is not _unset:
                if reuse_address:
                    raise ValueError("Passing `reuse_address=True` is no "
                                     "longer supported, as the usage of "
                                     "SO_REUSEPORT in UDP poses a significant "
                                     "security concern.")
                else:
                    warnings_warn("The *reuse_address* parameter has been "
                                  "deprecated as of 0.15.", DeprecationWarning,
                                  stacklevel=2)
            reuse_port = bool(reuse_port)
            if reuse_port and not has_SO_REUSEPORT:
                raise ValueError(
                    'reuse_port not supported by socket module')

            lads = None
            if local_addr is not None:
                if (not isinstance(local_addr, (tuple, list)) or
                        len(local_addr) != 2):
                    raise TypeError(
                        'local_addr must be a tuple of (host, port)')
                lads = await self._getaddrinfo(
                    local_addr[0], local_addr[1],
                    family, uv.SOCK_DGRAM, proto, flags,
                    0)

            rads = None
            if remote_addr is not None:
                if (not isinstance(remote_addr, (tuple, list)) or
                        len(remote_addr) != 2):
                    raise TypeError(
                        'remote_addr must be a tuple of (host, port)')
                rads = await self._getaddrinfo(
                    remote_addr[0], remote_addr[1],
                    family, uv.SOCK_DGRAM, proto, flags,
                    0)

            excs = []
            if lads is None:
                if rads is not None:
                    udp = UDPTransport.__new__(UDPTransport)
                    rai = (<AddrInfo>rads).data
                    udp._init(self, rai.ai_family)
                    udp._connect(rai.ai_addr, rai.ai_addrlen)
                    udp._set_address(rai)
                else:
                    if family not in (uv.AF_INET, uv.AF_INET6):
                        raise ValueError('unexpected address family')
                    udp = UDPTransport.__new__(UDPTransport)
                    udp._init(self, family)

                if reuse_port:
                    self._sock_set_reuseport(udp._fileno())

            else:
                lai = (<AddrInfo>lads).data
                while lai is not NULL:
                    try:
                        udp = UDPTransport.__new__(UDPTransport)
                        udp._init(self, lai.ai_family)
                        if reuse_port:
                            self._sock_set_reuseport(udp._fileno())
                        udp._bind(lai.ai_addr)
                    except (KeyboardInterrupt, SystemExit):
                        raise
                    except BaseException as ex:
                        lai = lai.ai_next
                        excs.append(ex)
                        continue
                    else:
                        break
                else:
                    ctx = None
                    if len(excs):
                        ctx = excs[0]
                    raise OSError('could not bind to local_addr {}'.format(
                        local_addr)) from ctx

                if rads is not None:
                    rai = (<AddrInfo>rads).data
                    while rai is not NULL:
                        if rai.ai_family != lai.ai_family:
                            rai = rai.ai_next
                            continue
                        if rai.ai_protocol != lai.ai_protocol:
                            rai = rai.ai_next
                            continue
                        udp._connect(rai.ai_addr, rai.ai_addrlen)
                        udp._set_address(rai)
                        break
                    else:
                        raise OSError(
                            'could not bind to remote_addr {}'.format(
                                remote_addr))

        if allow_broadcast:
            udp._set_broadcast(1)

        protocol = protocol_factory()
        waiter = self._new_future()
        assert udp is not None
        udp._set_protocol(protocol)
        udp._set_waiter(waiter)
        udp._init_protocol()

        await waiter
        return udp, protocol

    def _monitor_fs(self, path: str, callback) -> asyncio.Handle:
        cdef:
            UVFSEvent fs_handle
            char* c_str_path

        self._check_closed()
        fs_handle = UVFSEvent.new(self, callback, None)
        p_bytes = path.encode('UTF-8')
        c_str_path = p_bytes
        flags = 0
        fs_handle.start(c_str_path, flags)
        return fs_handle

    def _check_default_executor(self):
        if self._executor_shutdown_called:
            raise RuntimeError('Executor shutdown has been called')

    def _asyncgen_finalizer_hook(self, agen):
        self._asyncgens.discard(agen)
        if not self.is_closed():
            self.call_soon_threadsafe(self.create_task, agen.aclose())

    def _asyncgen_firstiter_hook(self, agen):
        if self._asyncgens_shutdown_called:
            warnings_warn(
                "asynchronous generator {!r} was scheduled after "
                "loop.shutdown_asyncgens() call".format(agen),
                ResourceWarning, source=self)

        self._asyncgens.add(agen)

    @cython.iterable_coroutine
    async def shutdown_asyncgens(self):
        """Shutdown all active asynchronous generators."""
        self._asyncgens_shutdown_called = True

        if not len(self._asyncgens):
            return

        closing_agens = list(self._asyncgens)
        self._asyncgens.clear()

        shutdown_coro = aio_gather(
            *[ag.aclose() for ag in closing_agens],
            return_exceptions=True)

        results = await shutdown_coro
        for result, agen in zip(results, closing_agens):
            if isinstance(result, Exception):
                self.call_exception_handler({
                    'message': 'an error occurred during closing of '
                               'asynchronous generator {!r}'.format(agen),
                    'exception': result,
                    'asyncgen': agen
                })

    @cython.iterable_coroutine
    async def shutdown_default_executor(self, timeout=None):
        """Schedule the shutdown of the default executor.

        The timeout parameter specifies the amount of time the executor will
        be given to finish joining. The default value is None, which means
        that the executor will be given an unlimited amount of time.
        """
        self._executor_shutdown_called = True
        if self._default_executor is None:
            return
        future = self.create_future()
        thread = threading_Thread(target=self._do_shutdown, args=(future,))
        thread.start()
        try:
            await future
        finally:
            thread.join(timeout)

        if thread.is_alive():
            warnings_warn(
                "The executor did not finishing joining "
                f"its threads within {timeout} seconds.",
                RuntimeWarning,
                stacklevel=2
            )
            self._default_executor.shutdown(wait=False)

    def _do_shutdown(self, future):
        try:
            self._default_executor.shutdown(wait=True)
            self.call_soon_threadsafe(future.set_result, None)
        except Exception as ex:
            self.call_soon_threadsafe(future.set_exception, ex)


# Expose pointer for integration with other C-extensions
def libuv_get_loop_t_ptr(loop):
    return PyCapsule_New(<void *>(<Loop>loop).uvloop, NULL, NULL)


def libuv_get_version():
    return uv.uv_version()


def _testhelper_unwrap_capsuled_pointer(obj):
    return <uint64_t>PyCapsule_GetPointer(obj, NULL)


cdef void __loop_alloc_buffer(
    uv.uv_handle_t* uvhandle,
    size_t suggested_size,
    uv.uv_buf_t* buf
) noexcept with gil:
    cdef:
        Loop loop = (<UVHandle>uvhandle.data)._loop

    if loop._recv_buffer_in_use == 1:
        buf.len = 0
        exc = RuntimeError('concurrent allocations')
        loop._handle_exception(exc)
        return

    loop._recv_buffer_in_use = 1
    buf.base = loop._recv_buffer
    buf.len = sizeof(loop._recv_buffer)


cdef inline void __loop_free_buffer(Loop loop):
    loop._recv_buffer_in_use = 0


class _SyncSocketReaderFuture(aio_Future):

    def __init__(self, sock, loop):
        aio_Future.__init__(self, loop=loop)
        self.__sock = sock
        self.__loop = loop

    def __remove_reader(self):
        if self.__sock is not None and self.__sock.fileno() != -1:
            self.__loop.remove_reader(self.__sock)
            self.__sock = None

    if PY39:
        def cancel(self, msg=None):
            self.__remove_reader()
            aio_Future.cancel(self, msg=msg)

    else:
        def cancel(self):
            self.__remove_reader()
            aio_Future.cancel(self)


class _SyncSocketWriterFuture(aio_Future):

    def __init__(self, sock, loop):
        aio_Future.__init__(self, loop=loop)
        self.__sock = sock
        self.__loop = loop

    def __remove_writer(self):
        if self.__sock is not None and self.__sock.fileno() != -1:
            self.__loop.remove_writer(self.__sock)
            self.__sock = None

    if PY39:
        def cancel(self, msg=None):
            self.__remove_writer()
            aio_Future.cancel(self, msg=msg)

    else:
        def cancel(self):
            self.__remove_writer()
            aio_Future.cancel(self)


include "cbhandles.pyx"
include "pseudosock.pyx"
include "lru.pyx"

include "handles/handle.pyx"
include "handles/async_.pyx"
include "handles/idle.pyx"
include "handles/check.pyx"
include "handles/timer.pyx"
include "handles/poll.pyx"
include "handles/basetransport.pyx"
include "handles/stream.pyx"
include "handles/streamserver.pyx"
include "handles/tcp.pyx"
include "handles/pipe.pyx"
include "handles/process.pyx"
include "handles/fsevent.pyx"

include "request.pyx"
include "dns.pyx"
include "sslproto.pyx"

include "handles/udp.pyx"

include "server.pyx"


# Used in UVProcess
cdef vint __atfork_installed = 0
cdef vint __forking = 0
cdef Loop __forking_loop = None


cdef void __get_fork_handler() noexcept nogil:
    with gil:
        if (__forking and __forking_loop is not None and
                __forking_loop.active_process_handler is not None):
            __forking_loop.active_process_handler._after_fork()

cdef __install_atfork():
    global __atfork_installed

    if __atfork_installed:
        return
    __atfork_installed = 1

    cdef int err

    err = system.pthread_atfork(NULL, NULL, &system.handleAtFork)
    if err:
        __atfork_installed = 0
        raise convert_error(-err)


# Install PyMem* memory allocators
cdef vint __mem_installed = 0
cdef __install_pymem():
    global __mem_installed
    if __mem_installed:
        return
    __mem_installed = 1

    cdef int err
    err = uv.uv_replace_allocator(<uv.uv_malloc_func>PyMem_RawMalloc,
                                  <uv.uv_realloc_func>PyMem_RawRealloc,
                                  <uv.uv_calloc_func>PyMem_RawCalloc,
                                  <uv.uv_free_func>PyMem_RawFree)
    if err < 0:
        __mem_installed = 0
        raise convert_error(err)


cdef _set_signal_wakeup_fd(fd):
    if fd >= 0:
        return signal_set_wakeup_fd(fd, warn_on_full_buffer=False)
    else:
        return signal_set_wakeup_fd(fd)


# Helpers for tests

@cython.iterable_coroutine
async def _test_coroutine_1():
    return 42
