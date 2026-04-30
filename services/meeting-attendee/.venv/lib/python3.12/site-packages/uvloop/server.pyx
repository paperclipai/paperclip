import asyncio


cdef class Server:
    def __cinit__(self, Loop loop):
        self._loop = loop
        self._servers = []
        self._waiters = []
        self._active_count = 0
        self._serving_forever_fut = None

    cdef _add_server(self, UVStreamServer srv):
        self._servers.append(srv)

    cdef _start_serving(self):
        if self._serving:
            return

        self._serving = 1
        for server in self._servers:
            (<UVStreamServer>server).listen()

    cdef _wakeup(self):
        cdef list waiters

        waiters = self._waiters
        self._waiters = None
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(waiter)

    cdef _attach(self):
        assert self._servers is not None
        self._active_count += 1

    cdef _detach(self):
        assert self._active_count > 0
        self._active_count -= 1
        if self._active_count == 0 and self._servers is None:
            self._wakeup()

    cdef _ref(self):
        # Keep the server object alive while it's not explicitly closed.
        self._loop._servers.add(self)

    cdef _unref(self):
        self._loop._servers.discard(self)

    # Public API

    @cython.iterable_coroutine
    async def __aenter__(self):
        return self

    @cython.iterable_coroutine
    async def __aexit__(self, *exc):
        self.close()
        await self.wait_closed()

    def __repr__(self):
        return '<%s sockets=%r>' % (self.__class__.__name__, self.sockets)

    def get_loop(self):
        return self._loop

    @cython.iterable_coroutine
    async def wait_closed(self):
        # Do not remove `self._servers is None` below
        # because close() method only closes server sockets
        # and existing client connections are left open.
        if self._servers is None or self._waiters is None:
            return
        waiter = self._loop._new_future()
        self._waiters.append(waiter)
        await waiter

    def close(self):
        cdef list servers

        if self._servers is None:
            return

        try:
            servers = self._servers
            self._servers = None
            self._serving = 0

            for server in servers:
                (<UVStreamServer>server)._close()

            if self._active_count == 0:
                self._wakeup()
        finally:
            self._unref()

    def is_serving(self):
        return self._serving

    @cython.iterable_coroutine
    async def start_serving(self):
        self._start_serving()

    @cython.iterable_coroutine
    async def serve_forever(self):
        if self._serving_forever_fut is not None:
            raise RuntimeError(
                f'server {self!r} is already being awaited on serve_forever()')
        if self._servers is None:
            raise RuntimeError(f'server {self!r} is closed')

        self._start_serving()
        self._serving_forever_fut = self._loop.create_future()

        try:
            await self._serving_forever_fut
        except asyncio.CancelledError:
            try:
                self.close()
                await self.wait_closed()
            finally:
                raise
        finally:
            self._serving_forever_fut = None

    property sockets:
        def __get__(self):
            cdef list sockets = []

            # Guard against `self._servers is None`
            if self._servers:
                for server in self._servers:
                    sockets.append(
                        (<UVStreamServer>server)._get_socket()
                    )

            return sockets
