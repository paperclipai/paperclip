# cython: language_level=3


from .includes cimport uv
from .includes cimport system

from libc.stdint cimport uint64_t, uint32_t, int64_t


include "includes/consts.pxi"


cdef extern from *:
    ctypedef int vint "volatile int"


cdef class UVHandle
cdef class UVSocketHandle(UVHandle)

cdef class UVAsync(UVHandle)
cdef class UVTimer(UVHandle)
cdef class UVIdle(UVHandle)

cdef class UVBaseTransport(UVSocketHandle)

ctypedef object (*method_t)(object)
ctypedef object (*method1_t)(object, object)
ctypedef object (*method2_t)(object, object, object)
ctypedef object (*method3_t)(object, object, object, object)


cdef class Loop:
    cdef:
        uv.uv_loop_t *uvloop

        bint _coroutine_debug_set
        int _coroutine_origin_tracking_saved_depth

        public slow_callback_duration

        readonly bint _closed
        bint _debug
        bint _running
        bint _stopping

        uint64_t _thread_id

        object _task_factory
        object _exception_handler
        object _default_executor
        object _ready
        set _queued_streams, _executing_streams
        Py_ssize_t _ready_len

        set _servers

        object _transports
        set _processes
        dict _fd_to_reader_fileobj
        dict _fd_to_writer_fileobj
        dict _unix_server_sockets

        set _signals
        dict _signal_handlers
        object _ssock
        object _csock
        bint _listening_signals
        int _old_signal_wakeup_id

        set _timers
        dict _polls

        UVProcess active_process_handler

        UVAsync handler_async
        UVIdle handler_idle
        UVCheck handler_check__exec_writes

        object _last_error

        cdef object __weakref__

        object _asyncgens
        bint _asyncgens_shutdown_called

        bint _executor_shutdown_called

        char _recv_buffer[UV_STREAM_RECV_BUF_SIZE]
        bint _recv_buffer_in_use

        # DEBUG fields
        # True when compiled with DEBUG.
        # Used only in unittests.
        readonly bint _debug_cc

        readonly object _debug_handles_total
        readonly object _debug_handles_closed
        readonly object _debug_handles_current

        readonly uint64_t _debug_uv_handles_total
        readonly uint64_t _debug_uv_handles_freed

        readonly uint64_t _debug_cb_handles_total
        readonly uint64_t _debug_cb_handles_count
        readonly uint64_t _debug_cb_timer_handles_total
        readonly uint64_t _debug_cb_timer_handles_count

        readonly uint64_t _debug_stream_shutdown_errors_total
        readonly uint64_t _debug_stream_listen_errors_total

        readonly uint64_t _debug_stream_read_cb_total
        readonly uint64_t _debug_stream_read_cb_errors_total
        readonly uint64_t _debug_stream_read_eof_total
        readonly uint64_t _debug_stream_read_eof_cb_errors_total
        readonly uint64_t _debug_stream_read_errors_total

        readonly uint64_t _debug_stream_write_tries
        readonly uint64_t _debug_stream_write_errors_total
        readonly uint64_t _debug_stream_write_ctx_total
        readonly uint64_t _debug_stream_write_ctx_cnt
        readonly uint64_t _debug_stream_write_cb_errors_total

        readonly uint64_t _poll_read_events_total
        readonly uint64_t _poll_read_cb_errors_total
        readonly uint64_t _poll_write_events_total
        readonly uint64_t _poll_write_cb_errors_total

        readonly uint64_t _sock_try_write_total

        readonly uint64_t _debug_exception_handler_cnt

    cdef _init_debug_fields(self)

    cdef _on_wake(self)
    cdef _on_idle(self)

    cdef __run(self, uv.uv_run_mode)
    cdef _run(self, uv.uv_run_mode)

    cdef _close(self)
    cdef _stop(self, exc)
    cdef uint64_t _time(self)

    cdef inline _queue_write(self, UVStream stream)
    cdef _exec_queued_writes(self)

    cdef inline _call_soon(self, object callback, object args, object context)
    cdef inline _append_ready_handle(self, Handle handle)
    cdef inline _call_soon_handle(self, Handle handle)

    cdef _call_later(self, uint64_t delay, object callback, object args,
                     object context)

    cdef void _handle_exception(self, object ex)

    cdef inline _is_main_thread(self)

    cdef inline _new_future(self)
    cdef inline _check_signal(self, sig)
    cdef inline _check_closed(self)
    cdef inline _check_thread(self)

    cdef _getaddrinfo(self, object host, object port,
                      int family, int type,
                      int proto, int flags,
                      int unpack)

    cdef _getnameinfo(self, system.sockaddr *addr, int flags)

    cdef _track_transport(self, UVBaseTransport transport)
    cdef _fileobj_to_fd(self, fileobj)
    cdef _ensure_fd_no_transport(self, fd)

    cdef _track_process(self, UVProcess proc)
    cdef _untrack_process(self, UVProcess proc)

    cdef _add_reader(self, fd, Handle handle)
    cdef _has_reader(self, fd)
    cdef _remove_reader(self, fd)

    cdef _add_writer(self, fd, Handle handle)
    cdef _has_writer(self, fd)
    cdef _remove_writer(self, fd)

    cdef _sock_recv(self, fut, sock, n)
    cdef _sock_recv_into(self, fut, sock, buf)
    cdef _sock_sendall(self, fut, sock, data)
    cdef _sock_accept(self, fut, sock)

    cdef _sock_connect(self, sock, address)
    cdef _sock_connect_cb(self, fut, sock, address)

    cdef _sock_set_reuseport(self, int fd)

    cdef _setup_or_resume_signals(self)
    cdef _shutdown_signals(self)
    cdef _pause_signals(self)

    cdef _handle_signal(self, sig)
    cdef _read_from_self(self)
    cdef inline _ceval_process_signals(self)
    cdef _invoke_signals(self, bytes data)

    cdef _set_coroutine_debug(self, bint enabled)

    cdef _print_debug_info(self)


include "cbhandles.pxd"

include "handles/handle.pxd"
include "handles/async_.pxd"
include "handles/idle.pxd"
include "handles/check.pxd"
include "handles/timer.pxd"
include "handles/poll.pxd"
include "handles/basetransport.pxd"
include "handles/stream.pxd"
include "handles/streamserver.pxd"
include "handles/tcp.pxd"
include "handles/pipe.pxd"
include "handles/process.pxd"
include "handles/fsevent.pxd"

include "request.pxd"
include "sslproto.pxd"

include "handles/udp.pxd"

include "server.pxd"
