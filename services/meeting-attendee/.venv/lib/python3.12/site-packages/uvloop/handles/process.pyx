@cython.no_gc_clear
cdef class UVProcess(UVHandle):
    """Abstract class; wrapper over uv_process_t handle."""

    def __cinit__(self):
        self.uv_opt_env = NULL
        self.uv_opt_args = NULL
        self._returncode = None
        self._pid = None
        self._fds_to_close = list()
        self._preexec_fn = None
        self._restore_signals = True
        self.context = Context_CopyCurrent()

    cdef _close_process_handle(self):
        # XXX: This is a workaround for a libuv bug:
        # - https://github.com/libuv/libuv/issues/1933
        # - https://github.com/libuv/libuv/pull/551
        if self._handle is NULL:
            return
        self._handle.data = NULL
        uv.uv_close(self._handle, __uv_close_process_handle_cb)
        self._handle = NULL  # close callback will free() the memory

    cdef _init(self, Loop loop, list args, dict env,
               cwd, start_new_session,
               _stdin, _stdout, _stderr,  # std* can be defined as macros in C
               pass_fds, debug_flags, preexec_fn, restore_signals):

        global __forking
        global __forking_loop
        global __forkHandler

        cdef int err

        self._start_init(loop)

        self._handle = <uv.uv_handle_t*>PyMem_RawMalloc(
            sizeof(uv.uv_process_t))
        if self._handle is NULL:
            self._abort_init()
            raise MemoryError()

        # Too early to call _finish_init, but still a lot of work to do.
        # Let's set handle.data to NULL, so in case something goes wrong,
        # callbacks have a chance to avoid casting *something* into UVHandle.
        self._handle.data = NULL

        force_fork = False
        if system.PLATFORM_IS_APPLE and not (
            preexec_fn is None
            and not pass_fds
        ):
            # see _execute_child() in CPython/subprocess.py
            force_fork = True

        try:
            self._init_options(args, env, cwd, start_new_session,
                               _stdin, _stdout, _stderr, force_fork)

            restore_inheritable = set()
            if pass_fds:
                for fd in pass_fds:
                    if not os_get_inheritable(fd):
                        restore_inheritable.add(fd)
                        os_set_inheritable(fd, True)
        except Exception:
            self._abort_init()
            raise

        if __forking or loop.active_process_handler is not None:
            # Our pthread_atfork handlers won't work correctly when
            # another loop is forking in another thread (even though
            # GIL should help us to avoid that.)
            self._abort_init()
            raise RuntimeError(
                'Racing with another loop to spawn a process.')

        self._errpipe_read, self._errpipe_write = os_pipe()
        fds_to_close = self._fds_to_close
        self._fds_to_close = None
        fds_to_close.append(self._errpipe_read)
        # add the write pipe last so we can close it early
        fds_to_close.append(self._errpipe_write)
        try:
            os_set_inheritable(self._errpipe_write, True)

            self._preexec_fn = preexec_fn
            self._restore_signals = restore_signals

            loop.active_process_handler = self
            __forking = 1
            __forking_loop = loop
            system.setForkHandler(<system.OnForkHandler>&__get_fork_handler)

            PyOS_BeforeFork()

            err = uv.uv_spawn(loop.uvloop,
                              <uv.uv_process_t*>self._handle,
                              &self.options)

            __forking = 0
            __forking_loop = None
            system.resetForkHandler()
            loop.active_process_handler = None

            PyOS_AfterFork_Parent()

            if err < 0:
                self._close_process_handle()
                self._abort_init()
                raise convert_error(err)

            self._finish_init()

            # close the write pipe early
            os_close(fds_to_close.pop())

            if preexec_fn is not None:
                errpipe_data = bytearray()
                while True:
                    # XXX: This is a blocking code that has to be
                    # rewritten (using loop.connect_read_pipe() or
                    # otherwise.)
                    part = os_read(self._errpipe_read, 50000)
                    errpipe_data += part
                    if not part or len(errpipe_data) > 50000:
                        break

        finally:
            while fds_to_close:
                os_close(fds_to_close.pop())

            for fd in restore_inheritable:
                os_set_inheritable(fd, False)

        # asyncio caches the PID in BaseSubprocessTransport,
        # so that the transport knows what the PID was even
        # after the process is finished.
        self._pid = (<uv.uv_process_t*>self._handle).pid

        # Track the process handle (create a strong ref to it)
        # to guarantee that __dealloc__ doesn't happen in an
        # uncontrolled fashion.  We want to wait until the process
        # exits and libuv calls __uvprocess_on_exit_callback,
        # which will call `UVProcess._close()`, which will, in turn,
        # untrack this handle.
        self._loop._track_process(self)

        if debug_flags & __PROCESS_DEBUG_SLEEP_AFTER_FORK:
            time_sleep(1)

        if preexec_fn is not None and errpipe_data:
            # preexec_fn has raised an exception.  The child
            # process must be dead now.
            try:
                exc_name, exc_msg = errpipe_data.split(b':', 1)
                exc_name = exc_name.decode()
                exc_msg = exc_msg.decode()
            except Exception:
                self._close()
                raise subprocess_SubprocessError(
                    'Bad exception data from child: {!r}'.format(
                        errpipe_data))
            exc_cls = getattr(__builtins__, exc_name,
                              subprocess_SubprocessError)

            exc = subprocess_SubprocessError(
                'Exception occurred in preexec_fn.')
            exc.__cause__ = exc_cls(exc_msg)
            self._close()
            raise exc

    cdef _after_fork(self):
        # See CPython/_posixsubprocess.c for details
        cdef int err

        if self._restore_signals:
            _Py_RestoreSignals()

        PyOS_AfterFork_Child()

        err = uv.uv_loop_fork(self._loop.uvloop)
        if err < 0:
            raise convert_error(err)

        if self._preexec_fn is not None:
            try:
                gc_disable()
                self._preexec_fn()
            except BaseException as ex:
                try:
                    with open(self._errpipe_write, 'wb') as f:
                        f.write(str(ex.__class__.__name__).encode())
                        f.write(b':')
                        f.write(str(ex.args[0]).encode())
                finally:
                    system._exit(255)
                    return
            else:
                os_close(self._errpipe_write)
        else:
            os_close(self._errpipe_write)

    cdef _close_after_spawn(self, int fd):
        if self._fds_to_close is None:
            raise RuntimeError(
                'UVProcess._close_after_spawn called after uv_spawn')
        self._fds_to_close.append(fd)

    def __dealloc__(self):
        if self.uv_opt_env is not NULL:
            PyMem_RawFree(self.uv_opt_env)
            self.uv_opt_env = NULL

        if self.uv_opt_args is not NULL:
            PyMem_RawFree(self.uv_opt_args)
            self.uv_opt_args = NULL

    cdef char** __to_cstring_array(self, list arr):
        cdef:
            int i
            ssize_t arr_len = len(arr)
            bytes el

            char **ret

        ret = <char **>PyMem_RawMalloc((arr_len + 1) * sizeof(char *))
        if ret is NULL:
            raise MemoryError()

        for i in range(arr_len):
            el = arr[i]
            # NB: PyBytes_AsString doesn't copy the data;
            # we have to be careful when the "arr" is GCed,
            # and it shouldn't be ever mutated.
            ret[i] = PyBytes_AsString(el)

        ret[arr_len] = NULL
        return ret

    cdef _init_options(self, list args, dict env, cwd, start_new_session,
                       _stdin, _stdout, _stderr, bint force_fork):

        memset(&self.options, 0, sizeof(uv.uv_process_options_t))

        self._init_env(env)
        self.options.env = self.uv_opt_env

        self._init_args(args)
        self.options.file = self.uv_opt_file
        self.options.args = self.uv_opt_args

        if start_new_session:
            self.options.flags |= uv.UV_PROCESS_DETACHED

        if force_fork:
            # This is a hack to work around the change in libuv 1.44:
            #    > macos: use posix_spawn instead of fork
            # where Python subprocess options like preexec_fn are
            # crippled. CPython only uses posix_spawn under a pretty
            # strict list of conditions (see subprocess.py), and falls
            # back to using fork() otherwise. We'd like to simulate such
            # behavior with libuv, but unfortunately libuv doesn't
            # provide explicit API to choose such implementation detail.
            # Based on current (libuv 1.46) behavior, setting
            # UV_PROCESS_SETUID or UV_PROCESS_SETGID would reliably make
            # libuv fallback to use fork, so let's just use it for now.
            self.options.flags |= uv.UV_PROCESS_SETUID
            self.options.uid = uv.getuid()

        if cwd is not None:
            cwd = os_fspath(cwd)

            if isinstance(cwd, str):
                cwd = PyUnicode_EncodeFSDefault(cwd)
            if not isinstance(cwd, bytes):
                raise ValueError('cwd must be a str or bytes object')

            self.__cwd = cwd
            self.options.cwd = PyBytes_AsString(self.__cwd)

        self.options.exit_cb = &__uvprocess_on_exit_callback

        self._init_files(_stdin, _stdout, _stderr)

    cdef _init_args(self, list args):
        cdef:
            bytes path
            int an = len(args)

        if an < 1:
            raise ValueError('cannot spawn a process: args are empty')

        self.__args = args.copy()
        for i in range(an):
            arg = os_fspath(args[i])
            if isinstance(arg, str):
                self.__args[i] = PyUnicode_EncodeFSDefault(arg)
            elif not isinstance(arg, bytes):
                raise TypeError('all args must be str or bytes')

        path = self.__args[0]
        self.uv_opt_file = PyBytes_AsString(path)
        self.uv_opt_args = self.__to_cstring_array(self.__args)

    cdef _init_env(self, dict env):
        if env is not None:
            self.__env = list()
            for key in env:
                val = env[key]

                if isinstance(key, str):
                    key = PyUnicode_EncodeFSDefault(key)
                elif not isinstance(key, bytes):
                    raise TypeError(
                        'all environment vars must be bytes or str')

                if isinstance(val, str):
                    val = PyUnicode_EncodeFSDefault(val)
                elif not isinstance(val, bytes):
                    raise TypeError(
                        'all environment values must be bytes or str')

                self.__env.append(key + b'=' + val)

            self.uv_opt_env = self.__to_cstring_array(self.__env)
        else:
            self.__env = None

    cdef _init_files(self, _stdin, _stdout, _stderr):
        self.options.stdio_count = 0

    cdef _kill(self, int signum):
        cdef int err
        self._ensure_alive()
        err = uv.uv_process_kill(<uv.uv_process_t*>self._handle, signum)
        if err < 0:
            raise convert_error(err)

    cdef _on_exit(self, int64_t exit_status, int term_signal):
        if term_signal:
            # From Python docs:
            #    A negative value -N indicates that the child was
            #    terminated by signal N (POSIX only).
            self._returncode = -term_signal
        else:
            self._returncode = exit_status

        self._close()

    cdef _close(self):
        try:
            if self._loop is not None:
                self._loop._untrack_process(self)
        finally:
            UVHandle._close(self)


DEF _CALL_PIPE_DATA_RECEIVED = 0
DEF _CALL_PIPE_CONNECTION_LOST = 1
DEF _CALL_PROCESS_EXITED = 2
DEF _CALL_CONNECTION_LOST = 3


@cython.no_gc_clear
cdef class UVProcessTransport(UVProcess):
    def __cinit__(self):
        self._exit_waiters = []
        self._protocol = None

        self._init_futs = []
        self._pending_calls = []
        self._stdio_ready = 0

        self._stdin = self._stdout = self._stderr = None
        self.stdin_proto = self.stdout_proto = self.stderr_proto = None

        self._finished = 0

    cdef _on_exit(self, int64_t exit_status, int term_signal):
        UVProcess._on_exit(self, exit_status, term_signal)

        if self._stdio_ready:
            self._loop.call_soon(self._protocol.process_exited,
                                 context=self.context)
        else:
            self._pending_calls.append((_CALL_PROCESS_EXITED, None, None))

        self._try_finish()

        for waiter in self._exit_waiters:
            if not waiter.cancelled():
                waiter.set_result(self._returncode)
        self._exit_waiters.clear()

        self._close()

    cdef _check_proc(self):
        if not self._is_alive() or self._returncode is not None:
            raise ProcessLookupError()

    cdef _pipe_connection_lost(self, int fd, exc):
        if self._stdio_ready:
            self._loop.call_soon(self._protocol.pipe_connection_lost, fd, exc,
                                 context=self.context)
            self._try_finish()
        else:
            self._pending_calls.append((_CALL_PIPE_CONNECTION_LOST, fd, exc))

    cdef _pipe_data_received(self, int fd, data):
        if self._stdio_ready:
            self._loop.call_soon(self._protocol.pipe_data_received, fd, data,
                                 context=self.context)
        else:
            self._pending_calls.append((_CALL_PIPE_DATA_RECEIVED, fd, data))

    cdef _file_redirect_stdio(self, int fd):
        fd = os_dup(fd)
        os_set_inheritable(fd, True)
        self._close_after_spawn(fd)
        return fd

    cdef _file_devnull(self):
        dn = os_open(os_devnull, os_O_RDWR)
        os_set_inheritable(dn, True)
        self._close_after_spawn(dn)
        return dn

    cdef _file_outpipe(self):
        r, w = __socketpair()
        os_set_inheritable(w, True)
        self._close_after_spawn(w)
        return r, w

    cdef _file_inpipe(self):
        r, w = __socketpair()
        os_set_inheritable(r, True)
        self._close_after_spawn(r)
        return r, w

    cdef _init_files(self, _stdin, _stdout, _stderr):
        cdef uv.uv_stdio_container_t *iocnt

        UVProcess._init_files(self, _stdin, _stdout, _stderr)

        io = [None, None, None]

        self.options.stdio_count = 3
        self.options.stdio = self.iocnt

        if _stdin is not None:
            if _stdin == subprocess_PIPE:
                r, w = self._file_inpipe()
                io[0] = r

                self.stdin_proto = WriteSubprocessPipeProto(self, 0)
                waiter = self._loop._new_future()
                self._stdin = WriteUnixTransport.new(
                    self._loop, self.stdin_proto, None, waiter)
                self._init_futs.append(waiter)
                self._stdin._open(w)
                self._stdin._init_protocol()
            elif _stdin == subprocess_DEVNULL:
                io[0] = self._file_devnull()
            elif _stdout == subprocess_STDOUT:
                raise ValueError(
                    'subprocess.STDOUT is supported only by stderr parameter')
            else:
                io[0] = self._file_redirect_stdio(_stdin)
        else:
            io[0] = self._file_redirect_stdio(0)

        if _stdout is not None:
            if _stdout == subprocess_PIPE:
                # We can't use UV_CREATE_PIPE here, since 'stderr' might be
                # set to 'subprocess.STDOUT', and there is no way to
                # emulate that functionality with libuv high-level
                # streams API. Therefore, we create pipes for stdout and
                # stderr manually.

                r, w = self._file_outpipe()
                io[1] = w

                self.stdout_proto = ReadSubprocessPipeProto(self, 1)
                waiter = self._loop._new_future()
                self._stdout = ReadUnixTransport.new(
                    self._loop, self.stdout_proto, None, waiter)
                self._init_futs.append(waiter)
                self._stdout._open(r)
                self._stdout._init_protocol()
            elif _stdout == subprocess_DEVNULL:
                io[1] = self._file_devnull()
            elif _stdout == subprocess_STDOUT:
                raise ValueError(
                    'subprocess.STDOUT is supported only by stderr parameter')
            else:
                io[1] = self._file_redirect_stdio(_stdout)
        else:
            io[1] = self._file_redirect_stdio(1)

        if _stderr is not None:
            if _stderr == subprocess_PIPE:
                r, w = self._file_outpipe()
                io[2] = w

                self.stderr_proto = ReadSubprocessPipeProto(self, 2)
                waiter = self._loop._new_future()
                self._stderr = ReadUnixTransport.new(
                    self._loop, self.stderr_proto, None, waiter)
                self._init_futs.append(waiter)
                self._stderr._open(r)
                self._stderr._init_protocol()
            elif _stderr == subprocess_STDOUT:
                if io[1] is None:
                    # shouldn't ever happen
                    raise RuntimeError('cannot apply subprocess.STDOUT')

                io[2] = self._file_redirect_stdio(io[1])
            elif _stderr == subprocess_DEVNULL:
                io[2] = self._file_devnull()
            else:
                io[2] = self._file_redirect_stdio(_stderr)
        else:
            io[2] = self._file_redirect_stdio(2)

        assert len(io) == 3
        for idx in range(3):
            iocnt = &self.iocnt[idx]
            if io[idx] is not None:
                iocnt.flags = uv.UV_INHERIT_FD
                iocnt.data.fd = io[idx]
            else:
                iocnt.flags = uv.UV_IGNORE

    cdef _call_connection_made(self, waiter):
        try:
            # we're always called in the right context, so just call the user's
            self._protocol.connection_made(self)
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as ex:
            if waiter is not None and not waiter.cancelled():
                waiter.set_exception(ex)
            else:
                raise
        else:
            if waiter is not None and not waiter.cancelled():
                waiter.set_result(True)

        self._stdio_ready = 1
        if self._pending_calls:
            pending_calls = self._pending_calls.copy()
            self._pending_calls.clear()
            for (type, fd, arg) in pending_calls:
                if type == _CALL_PIPE_CONNECTION_LOST:
                    self._pipe_connection_lost(fd, arg)
                elif type == _CALL_PIPE_DATA_RECEIVED:
                    self._pipe_data_received(fd, arg)
                elif type == _CALL_PROCESS_EXITED:
                    self._loop.call_soon(self._protocol.process_exited)
                elif type == _CALL_CONNECTION_LOST:
                    self._loop.call_soon(self._protocol.connection_lost, None)

    cdef _try_finish(self):
        if self._returncode is None or self._finished:
            return

        if ((self.stdin_proto is None or self.stdin_proto.disconnected) and
                (self.stdout_proto is None or
                    self.stdout_proto.disconnected) and
                (self.stderr_proto is None or
                    self.stderr_proto.disconnected)):

            self._finished = 1

            if self._stdio_ready:
                # copy self.context for simplicity
                self._loop.call_soon(self._protocol.connection_lost, None,
                                     context=self.context)
            else:
                self._pending_calls.append((_CALL_CONNECTION_LOST, None, None))

    def __stdio_inited(self, waiter, stdio_fut):
        exc = stdio_fut.exception()
        if exc is not None:
            if waiter is None:
                raise exc
            else:
                waiter.set_exception(exc)
        else:
            self._loop._call_soon_handle(
                new_MethodHandle1(self._loop,
                                  "UVProcessTransport._call_connection_made",
                                  <method1_t>self._call_connection_made,
                                  None,  # means to copy the current context
                                  self, waiter))

    @staticmethod
    cdef UVProcessTransport new(Loop loop, protocol, args, env,
                                cwd, start_new_session,
                                _stdin, _stdout, _stderr, pass_fds,
                                waiter,
                                debug_flags,
                                preexec_fn,
                                restore_signals):

        cdef UVProcessTransport handle
        handle = UVProcessTransport.__new__(UVProcessTransport)
        handle._protocol = protocol
        handle._init(loop, args, env, cwd, start_new_session,
                     __process_convert_fileno(_stdin),
                     __process_convert_fileno(_stdout),
                     __process_convert_fileno(_stderr),
                     pass_fds,
                     debug_flags,
                     preexec_fn,
                     restore_signals)

        if handle._init_futs:
            handle._stdio_ready = 0
            init_fut = aio_gather(*handle._init_futs)
            # add_done_callback will copy the current context and run the
            # callback within the context
            init_fut.add_done_callback(
                ft_partial(handle.__stdio_inited, waiter))
        else:
            handle._stdio_ready = 1
            loop._call_soon_handle(
                new_MethodHandle1(loop,
                                  "UVProcessTransport._call_connection_made",
                                  <method1_t>handle._call_connection_made,
                                  None,  # means to copy the current context
                                  handle, waiter))

        return handle

    def get_protocol(self):
        return self._protocol

    def set_protocol(self, protocol):
        self._protocol = protocol

    def get_pid(self):
        return self._pid

    def get_returncode(self):
        return self._returncode

    def get_pipe_transport(self, fd):
        if fd == 0:
            return self._stdin
        elif fd == 1:
            return self._stdout
        elif fd == 2:
            return self._stderr

    def terminate(self):
        self._check_proc()
        self._kill(uv.SIGTERM)

    def kill(self):
        self._check_proc()
        self._kill(uv.SIGKILL)

    def send_signal(self, int signal):
        self._check_proc()
        self._kill(signal)

    def is_closing(self):
        return self._closed

    def close(self):
        if self._returncode is None:
            self._kill(uv.SIGKILL)

        if self._stdin is not None:
            self._stdin.close()
        if self._stdout is not None:
            self._stdout.close()
        if self._stderr is not None:
            self._stderr.close()

        if self._returncode is not None:
            # The process is dead, just close the UV handle.
            #
            # (If "self._returncode is None", the process should have been
            # killed already and we're just waiting for a SIGCHLD; after
            # which the transport will be GC'ed and the uvhandle will be
            # closed in UVHandle.__dealloc__.)
            self._close()

    def get_extra_info(self, name, default=None):
        return default

    def _wait(self):
        fut = self._loop._new_future()
        if self._returncode is not None:
            fut.set_result(self._returncode)
            return fut

        self._exit_waiters.append(fut)
        return fut


class WriteSubprocessPipeProto(aio_BaseProtocol):

    def __init__(self, proc, fd):
        if UVLOOP_DEBUG:
            if type(proc) is not UVProcessTransport:
                raise TypeError
            if not isinstance(fd, int):
                raise TypeError
        self.proc = proc
        self.fd = fd
        self.pipe = None
        self.disconnected = False

    def connection_made(self, transport):
        self.pipe = transport

    def __repr__(self):
        return ('<%s fd=%s pipe=%r>'
                % (self.__class__.__name__, self.fd, self.pipe))

    def connection_lost(self, exc):
        self.disconnected = True
        (<UVProcessTransport>self.proc)._pipe_connection_lost(self.fd, exc)
        self.proc = None

    def pause_writing(self):
        (<UVProcessTransport>self.proc)._protocol.pause_writing()

    def resume_writing(self):
        (<UVProcessTransport>self.proc)._protocol.resume_writing()


class ReadSubprocessPipeProto(WriteSubprocessPipeProto,
                              aio_Protocol):

    def data_received(self, data):
        (<UVProcessTransport>self.proc)._pipe_data_received(self.fd, data)


cdef __process_convert_fileno(object obj):
    if obj is None or isinstance(obj, int):
        return obj

    fileno = obj.fileno()
    if not isinstance(fileno, int):
        raise TypeError(
            '{!r}.fileno() returned non-integer'.format(obj))
    return fileno


cdef void __uvprocess_on_exit_callback(
    uv.uv_process_t *handle,
    int64_t exit_status,
    int term_signal,
) noexcept with gil:

    if __ensure_handle_data(<uv.uv_handle_t*>handle,
                            "UVProcess exit callback") == 0:
        return

    cdef UVProcess proc = <UVProcess> handle.data
    try:
        proc._on_exit(exit_status, term_signal)
    except BaseException as ex:
        proc._error(ex, False)


cdef __socketpair():
    cdef:
        int fds[2]
        int err

    err = system.socketpair(uv.AF_UNIX, uv.SOCK_STREAM, 0, fds)
    if err:
        exc = convert_error(-err)
        raise exc

    os_set_inheritable(fds[0], False)
    os_set_inheritable(fds[1], False)

    return fds[0], fds[1]


cdef void __uv_close_process_handle_cb(
    uv.uv_handle_t* handle
) noexcept with gil:
    PyMem_RawFree(handle)
