from libc.stdint cimport uint16_t, uint32_t, uint64_t, int64_t
from posix.types cimport gid_t, uid_t
from posix.unistd cimport getuid

from . cimport system

# This is an internal enum UV_HANDLE_READABLE from uv-common.h, used only by
# handles/pipe.pyx to temporarily workaround a libuv issue libuv/libuv#2058,
# before there is a proper fix in libuv. In short, libuv disallowed feeding a
# write-only pipe to uv_read_start(), which was needed by uvloop to detect a
# broken pipe without having to send anything on the write-only end. We're
# setting UV_HANDLE_READABLE on pipe_t to workaround this limitation
# temporarily, please see also #317.
cdef enum:
    UV_INTERNAL_HANDLE_READABLE = 0x00004000

cdef extern from "uv.h" nogil:
    cdef int UV_TCP_IPV6ONLY

    cdef int UV_EACCES
    cdef int UV_EAGAIN
    cdef int UV_EALREADY
    cdef int UV_EBUSY
    cdef int UV_ECONNABORTED
    cdef int UV_ECONNREFUSED
    cdef int UV_ECONNRESET
    cdef int UV_ECANCELED
    cdef int UV_EEXIST
    cdef int UV_EINTR
    cdef int UV_EINVAL
    cdef int UV_EISDIR
    cdef int UV_ENOENT
    cdef int UV_EOF
    cdef int UV_EPERM
    cdef int UV_EPIPE
    cdef int UV_ESHUTDOWN
    cdef int UV_ESRCH
    cdef int UV_ETIMEDOUT
    cdef int UV_EBADF
    cdef int UV_ENOBUFS

    cdef int UV_EAI_ADDRFAMILY
    cdef int UV_EAI_AGAIN
    cdef int UV_EAI_BADFLAGS
    cdef int UV_EAI_BADHINTS
    cdef int UV_EAI_CANCELED
    cdef int UV_EAI_FAIL
    cdef int UV_EAI_FAMILY
    cdef int UV_EAI_MEMORY
    cdef int UV_EAI_NODATA
    cdef int UV_EAI_NONAME
    cdef int UV_EAI_OVERFLOW
    cdef int UV_EAI_PROTOCOL
    cdef int UV_EAI_SERVICE
    cdef int UV_EAI_SOCKTYPE

    cdef int SOL_SOCKET
    cdef int SO_ERROR
    cdef int SO_REUSEADDR
    # use has_SO_REUSEPORT and SO_REUSEPORT in stdlib.pxi instead
    cdef int AF_INET
    cdef int AF_INET6
    cdef int AF_UNIX
    cdef int AF_UNSPEC
    cdef int AI_PASSIVE
    cdef int AI_NUMERICHOST
    cdef int INET6_ADDRSTRLEN
    cdef int IPPROTO_IPV6
    cdef int SOCK_STREAM
    cdef int SOCK_DGRAM
    cdef int IPPROTO_TCP
    cdef int IPPROTO_UDP

    cdef int SIGINT
    cdef int SIGHUP
    cdef int SIGCHLD
    cdef int SIGKILL
    cdef int SIGTERM

    ctypedef int uv_os_sock_t
    ctypedef int uv_file
    ctypedef int uv_os_fd_t

    ctypedef struct uv_buf_t:
        char* base
        size_t len

    ctypedef struct uv_loop_t:
        void* data
        # ...

    ctypedef struct uv_handle_t:
        void* data
        uv_loop_t* loop
        unsigned int flags
        # ...

    ctypedef struct uv_idle_t:
        void* data
        uv_loop_t* loop
        # ...

    ctypedef struct uv_check_t:
        void* data
        uv_loop_t* loop
        # ...

    ctypedef struct uv_signal_t:
        void* data
        uv_loop_t* loop
        # ...

    ctypedef struct uv_async_t:
        void* data
        uv_loop_t* loop
        # ...

    ctypedef struct uv_timer_t:
        void* data
        uv_loop_t* loop
        # ...

    ctypedef struct uv_stream_t:
        void* data
        size_t write_queue_size
        uv_loop_t* loop
        # ...

    ctypedef struct uv_tcp_t:
        void* data
        uv_loop_t* loop
        # ...

    ctypedef struct uv_pipe_t:
        void* data
        uv_loop_t* loop
        # ...

    ctypedef struct uv_udp_t:
        void* data
        uv_loop_t* loop
        size_t send_queue_size
        size_t send_queue_count
        # ...

    ctypedef struct uv_udp_send_t:
        void* data
        uv_udp_t* handle

    ctypedef struct uv_poll_t:
        void* data
        uv_loop_t* loop
        # ...

    ctypedef struct uv_req_t:
        # Only cancellation of uv_fs_t, uv_getaddrinfo_t,
        # uv_getnameinfo_t and uv_work_t requests is
        # currently supported.
        void* data
        uv_req_type type
        # ...

    ctypedef struct uv_connect_t:
        void* data

    ctypedef struct uv_getaddrinfo_t:
        void* data
        # ...

    ctypedef struct uv_getnameinfo_t:
        void* data
        # ...

    ctypedef struct uv_write_t:
        void* data
        # ...

    ctypedef struct uv_shutdown_t:
        void* data
        # ...

    ctypedef struct uv_process_t:
        void* data
        int pid
        # ...

    ctypedef struct uv_fs_event_t:
        void* data
        # ...

    ctypedef enum uv_req_type:
        UV_UNKNOWN_REQ = 0,
        UV_REQ,
        UV_CONNECT,
        UV_WRITE,
        UV_SHUTDOWN,
        UV_UDP_SEND,
        UV_FS,
        UV_WORK,
        UV_GETADDRINFO,
        UV_GETNAMEINFO,
        UV_REQ_TYPE_PRIVATE,
        UV_REQ_TYPE_MAX

    ctypedef enum uv_run_mode:
        UV_RUN_DEFAULT = 0,
        UV_RUN_ONCE,
        UV_RUN_NOWAIT

    ctypedef enum uv_poll_event:
        UV_READABLE = 1,
        UV_WRITABLE = 2,
        UV_DISCONNECT = 4

    ctypedef enum uv_udp_flags:
        UV_UDP_IPV6ONLY = 1,
        UV_UDP_PARTIAL = 2

    ctypedef enum uv_membership:
        UV_LEAVE_GROUP = 0,
        UV_JOIN_GROUP

    cdef enum uv_fs_event:
        UV_RENAME = 1,
        UV_CHANGE = 2

    const char* uv_strerror(int err)
    const char* uv_err_name(int err)

    ctypedef void (*uv_walk_cb)(uv_handle_t* handle, void* arg) with gil

    ctypedef void (*uv_close_cb)(uv_handle_t* handle) with gil
    ctypedef void (*uv_idle_cb)(uv_idle_t* handle) with gil
    ctypedef void (*uv_check_cb)(uv_check_t* handle) with gil
    ctypedef void (*uv_signal_cb)(uv_signal_t* handle, int signum) with gil
    ctypedef void (*uv_async_cb)(uv_async_t* handle) with gil
    ctypedef void (*uv_timer_cb)(uv_timer_t* handle) with gil
    ctypedef void (*uv_connection_cb)(uv_stream_t* server, int status) with gil
    ctypedef void (*uv_alloc_cb)(uv_handle_t* handle,
                                 size_t suggested_size,
                                 uv_buf_t* buf) with gil
    ctypedef void (*uv_read_cb)(uv_stream_t* stream,
                                ssize_t nread,
                                const uv_buf_t* buf) with gil
    ctypedef void (*uv_write_cb)(uv_write_t* req, int status) with gil
    ctypedef void (*uv_getaddrinfo_cb)(uv_getaddrinfo_t* req,
                                       int status,
                                       system.addrinfo* res) with gil
    ctypedef void (*uv_getnameinfo_cb)(uv_getnameinfo_t* req,
                                       int status,
                                       const char* hostname,
                                       const char* service) with gil
    ctypedef void (*uv_shutdown_cb)(uv_shutdown_t* req, int status) with gil
    ctypedef void (*uv_poll_cb)(uv_poll_t* handle,
                                int status, int events) with gil

    ctypedef void (*uv_connect_cb)(uv_connect_t* req, int status) with gil

    ctypedef void (*uv_udp_send_cb)(uv_udp_send_t* req, int status) with gil
    ctypedef void (*uv_udp_recv_cb)(uv_udp_t* handle,
                                    ssize_t nread,
                                    const uv_buf_t* buf,
                                    const system.sockaddr* addr,
                                    unsigned flags) with gil
    ctypedef void (*uv_fs_event_cb)(uv_fs_event_t* handle,
                                    const char *filename,
                                    int events,
                                    int status) with gil

    # Generic request functions
    int uv_cancel(uv_req_t* req)

    # Generic handler functions
    int uv_is_active(const uv_handle_t* handle)
    void uv_close(uv_handle_t* handle, uv_close_cb close_cb)
    int uv_is_closing(const uv_handle_t* handle)
    int uv_fileno(const uv_handle_t* handle, uv_os_fd_t* fd)
    void uv_walk(uv_loop_t* loop, uv_walk_cb walk_cb, void* arg)

    # Loop functions
    int uv_loop_init(uv_loop_t* loop)
    int uv_loop_close(uv_loop_t* loop)
    int uv_loop_alive(uv_loop_t* loop)
    int uv_loop_fork(uv_loop_t* loop)
    uv_os_fd_t uv_backend_fd(uv_loop_t* loop)

    void uv_update_time(uv_loop_t* loop)
    uint64_t uv_now(const uv_loop_t*)

    int uv_run(uv_loop_t*, uv_run_mode mode) nogil
    void uv_stop(uv_loop_t*)

    # Idle handler
    int uv_idle_init(uv_loop_t*, uv_idle_t* idle)
    int uv_idle_start(uv_idle_t* idle, uv_idle_cb cb)
    int uv_idle_stop(uv_idle_t* idle)

    # Check handler
    int uv_check_init(uv_loop_t*, uv_check_t* idle)
    int uv_check_start(uv_check_t* check, uv_check_cb cb)
    int uv_check_stop(uv_check_t* check)

    # Signal handler
    int uv_signal_init(uv_loop_t* loop, uv_signal_t* handle)
    int uv_signal_start(uv_signal_t* handle,
                        uv_signal_cb signal_cb,
                        int signum)
    int uv_signal_stop(uv_signal_t* handle)

    # Async handler
    int uv_async_init(uv_loop_t*,
                      uv_async_t* async_,
                      uv_async_cb async_cb)
    int uv_async_send(uv_async_t* async_)

    # Timer handler
    int uv_timer_init(uv_loop_t*, uv_timer_t* handle)
    int uv_timer_start(uv_timer_t* handle,
                       uv_timer_cb cb,
                       uint64_t timeout,
                       uint64_t repeat)
    int uv_timer_stop(uv_timer_t* handle)

    # DNS
    int uv_getaddrinfo(uv_loop_t* loop,
                       uv_getaddrinfo_t* req,
                       uv_getaddrinfo_cb getaddrinfo_cb,
                       const char* node,
                       const char* service,
                       const system.addrinfo* hints)

    void uv_freeaddrinfo(system.addrinfo* ai)

    int uv_getnameinfo(uv_loop_t* loop,
                       uv_getnameinfo_t* req,
                       uv_getnameinfo_cb getnameinfo_cb,
                       const system.sockaddr* addr,
                       int flags)

    int uv_ip4_name(const system.sockaddr_in* src, char* dst, size_t size)
    int uv_ip6_name(const system.sockaddr_in6* src, char* dst, size_t size)

    # Streams

    int uv_listen(uv_stream_t* stream, int backlog, uv_connection_cb cb)
    int uv_accept(uv_stream_t* server, uv_stream_t* client)
    int uv_read_start(uv_stream_t* stream,
                      uv_alloc_cb alloc_cb,
                      uv_read_cb read_cb)
    int uv_read_stop(uv_stream_t*)
    int uv_write(uv_write_t* req, uv_stream_t* handle,
                 uv_buf_t bufs[], unsigned int nbufs, uv_write_cb cb)

    int uv_try_write(uv_stream_t* handle, uv_buf_t bufs[], unsigned int nbufs)

    int uv_shutdown(uv_shutdown_t* req, uv_stream_t* handle, uv_shutdown_cb cb)

    int uv_is_readable(const uv_stream_t* handle)
    int uv_is_writable(const uv_stream_t* handle)

    # TCP

    int uv_tcp_init_ex(uv_loop_t*, uv_tcp_t* handle, unsigned int flags)
    int uv_tcp_nodelay(uv_tcp_t* handle, int enable)
    int uv_tcp_keepalive(uv_tcp_t* handle, int enable, unsigned int delay)
    int uv_tcp_open(uv_tcp_t* handle, uv_os_sock_t sock)
    int uv_tcp_bind(uv_tcp_t* handle, system.sockaddr* addr,
                    unsigned int flags)

    int uv_tcp_getsockname(const uv_tcp_t* handle, system.sockaddr* name,
                           int* namelen)
    int uv_tcp_getpeername(const uv_tcp_t* handle, system.sockaddr* name,
                           int* namelen)

    int uv_tcp_connect(uv_connect_t* req, uv_tcp_t* handle,
                       const system.sockaddr* addr, uv_connect_cb cb)

    # Pipes

    int uv_pipe_init(uv_loop_t* loop, uv_pipe_t* handle, int ipc)
    int uv_pipe_open(uv_pipe_t* handle, uv_os_fd_t file)
    int uv_pipe_bind(uv_pipe_t* handle, const char* name)

    void uv_pipe_connect(uv_connect_t* req, uv_pipe_t* handle,
                         const char* name, uv_connect_cb cb)

    # UDP

    int uv_udp_init_ex(uv_loop_t* loop, uv_udp_t* handle, unsigned int flags)
    int uv_udp_connect(uv_udp_t* handle, const system.sockaddr* addr)
    int uv_udp_open(uv_udp_t* handle, uv_os_sock_t sock)
    int uv_udp_bind(uv_udp_t* handle, const system.sockaddr* addr,
                    unsigned int flags)
    int uv_udp_send(uv_udp_send_t* req, uv_udp_t* handle,
                    const uv_buf_t bufs[], unsigned int nbufs,
                    const system.sockaddr* addr, uv_udp_send_cb send_cb)
    int uv_udp_try_send(uv_udp_t* handle,
                        const uv_buf_t bufs[], unsigned int nbufs,
                        const system.sockaddr* addr)
    int uv_udp_recv_start(uv_udp_t* handle, uv_alloc_cb alloc_cb,
                          uv_udp_recv_cb recv_cb)
    int uv_udp_recv_stop(uv_udp_t* handle)
    int uv_udp_set_broadcast(uv_udp_t* handle, int on)

    # Polling

    int uv_poll_init(uv_loop_t* loop, uv_poll_t* handle, int fd)
    int uv_poll_init_socket(uv_loop_t* loop, uv_poll_t* handle,
                            uv_os_sock_t socket)
    int uv_poll_start(uv_poll_t* handle, int events, uv_poll_cb cb)
    int uv_poll_stop(uv_poll_t* poll)

    # FS Event

    int uv_fs_event_init(uv_loop_t *loop, uv_fs_event_t *handle)
    int uv_fs_event_start(uv_fs_event_t *handle, uv_fs_event_cb cb,
                          const char *path, unsigned int flags)
    int uv_fs_event_stop(uv_fs_event_t *handle)

    # Misc

    ctypedef struct uv_timeval_t:
        long tv_sec
        long tv_usec

    ctypedef struct uv_rusage_t:
        uv_timeval_t ru_utime   # user CPU time used
        uv_timeval_t ru_stime   # system CPU time used
        uint64_t ru_maxrss      # maximum resident set size
        uint64_t ru_ixrss       # integral shared memory size
        uint64_t ru_idrss       # integral unshared data size
        uint64_t ru_isrss       # integral unshared stack size
        uint64_t ru_minflt      # page reclaims (soft page faults)
        uint64_t ru_majflt      # page faults (hard page faults)
        uint64_t ru_nswap       # swaps
        uint64_t ru_inblock     # block input operations
        uint64_t ru_oublock     # block output operations
        uint64_t ru_msgsnd      # IPC messages sent
        uint64_t ru_msgrcv      # IPC messages received
        uint64_t ru_nsignals    # signals received
        uint64_t ru_nvcsw       # voluntary context switches
        uint64_t ru_nivcsw      # involuntary context switches

    int uv_getrusage(uv_rusage_t* rusage)

    int uv_ip4_addr(const char* ip, int port, system.sockaddr_in* addr)
    int uv_ip6_addr(const char* ip, int port, system.sockaddr_in6* addr)

    # Memory Allocation

    ctypedef void* (*uv_malloc_func)(size_t size)
    ctypedef void* (*uv_realloc_func)(void* ptr, size_t size)
    ctypedef void* (*uv_calloc_func)(size_t count, size_t size)
    ctypedef void (*uv_free_func)(void* ptr)

    int uv_replace_allocator(uv_malloc_func malloc_func,
                             uv_realloc_func realloc_func,
                             uv_calloc_func calloc_func,
                             uv_free_func free_func)

    # Process

    ctypedef void (*uv_exit_cb)(uv_process_t*, int64_t exit_status,
                                int term_signal) with gil

    ctypedef enum uv_process_flags:
        UV_PROCESS_SETUID = 1,
        UV_PROCESS_SETGID = 2,
        UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS = 4,
        UV_PROCESS_DETACHED = 8,
        UV_PROCESS_WINDOWS_HIDE = 16

    ctypedef enum uv_stdio_flags:
        UV_IGNORE = 0x00,
        UV_CREATE_PIPE = 0x01,
        UV_INHERIT_FD = 0x02,
        UV_INHERIT_STREAM = 0x04,
        UV_READABLE_PIPE = 0x10,
        UV_WRITABLE_PIPE = 0x20

    ctypedef union uv_stdio_container_data_u:
        uv_stream_t* stream
        int fd

    ctypedef struct uv_stdio_container_t:
        uv_stdio_flags flags
        uv_stdio_container_data_u data

    ctypedef struct uv_process_options_t:
        uv_exit_cb exit_cb
        char* file
        char** args
        char** env
        char* cwd
        unsigned int flags
        int stdio_count
        uv_stdio_container_t* stdio
        uid_t uid
        gid_t gid

    int uv_spawn(uv_loop_t* loop, uv_process_t* handle,
                 const uv_process_options_t* options)

    int uv_process_kill(uv_process_t* handle, int signum)

    unsigned int uv_version()
