@cython.no_gc_clear
@cython.freelist(DEFAULT_FREELIST_SIZE)
cdef class Handle:
    def __cinit__(self):
        self._cancelled = 0
        self.cb_type = 0
        self._source_traceback = None

    cdef inline _set_loop(self, Loop loop):
        self.loop = loop
        if UVLOOP_DEBUG:
            loop._debug_cb_handles_total += 1
            loop._debug_cb_handles_count += 1
        if loop._debug:
            self._source_traceback = extract_stack()

    cdef inline _set_context(self, object context):
        if context is None:
            context = Context_CopyCurrent()
        self.context = context

    def __dealloc__(self):
        if UVLOOP_DEBUG and self.loop is not None:
            self.loop._debug_cb_handles_count -= 1
        if self.loop is None:
            raise RuntimeError('Handle.loop is None in Handle.__dealloc__')

    def __init__(self):
        raise TypeError(
            '{} is not supposed to be instantiated from Python'.format(
                self.__class__.__name__))

    cdef inline _run(self):
        cdef:
            int cb_type
            object callback

        if self._cancelled:
            return

        cb_type = self.cb_type

        # Since _run is a cdef and there's no BoundMethod,
        # we guard 'self' manually (since the callback
        # might cause GC of the handle.)
        Py_INCREF(self)

        try:
            assert self.context is not None
            Context_Enter(self.context)

            if cb_type == 1:
                callback = self.arg1
                if callback is None:
                    raise RuntimeError(
                        'cannot run Handle; callback is not set')

                args = self.arg2

                if args is None:
                    callback()
                else:
                    callback(*args)

            elif cb_type == 2:
                (<method_t>self.callback)(self.arg1)

            elif cb_type == 3:
                (<method1_t>self.callback)(self.arg1, self.arg2)

            elif cb_type == 4:
                (<method2_t>self.callback)(self.arg1, self.arg2, self.arg3)

            elif cb_type == 5:
                (<method3_t>self.callback)(
                    self.arg1, self.arg2, self.arg3, self.arg4)

            else:
                raise RuntimeError('invalid Handle.cb_type: {}'.format(
                    cb_type))

        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as ex:
            if cb_type == 1:
                msg = 'Exception in callback {}'.format(callback)
            else:
                msg = 'Exception in callback {}'.format(self.meth_name)

            context = {
                'message': msg,
                'exception': ex,
                'handle': self,
            }

            if self._source_traceback is not None:
                context['source_traceback'] = self._source_traceback

            self.loop.call_exception_handler(context)

        finally:
            context = self.context
            Py_DECREF(self)
            Context_Exit(context)

    cdef _cancel(self):
        self._cancelled = 1
        self.callback = NULL
        self.arg1 = self.arg2 = self.arg3 = self.arg4 = None

    cdef _format_handle(self):
        # Mirrors `asyncio.base_events._format_handle`.
        if self.cb_type == 1 and self.arg1 is not None:
            cb = self.arg1
            if isinstance(getattr(cb, '__self__', None), aio_Task):
                try:
                    return repr(cb.__self__)
                except (AttributeError, TypeError, ValueError) as ex:
                    # Cython generates empty __code__ objects for coroutines
                    # that can crash asyncio.Task.__repr__ with an
                    # AttributeError etc.  Guard against that.
                    self.loop.call_exception_handler({
                        'message': 'exception in Task.__repr__',
                        'task': cb.__self__,
                        'exception': ex,
                        'handle': self,
                    })
        return repr(self)

    # Public API

    def __repr__(self):
        info = [self.__class__.__name__]

        if self._cancelled:
            info.append('cancelled')

        if self.cb_type == 1 and self.arg1 is not None:
            func = self.arg1
            # Cython can unset func.__qualname__/__name__, hence the checks.
            if hasattr(func, '__qualname__') and func.__qualname__:
                cb_name = func.__qualname__
            elif hasattr(func, '__name__') and func.__name__:
                cb_name = func.__name__
            else:
                cb_name = repr(func)

            info.append(cb_name)
        elif self.meth_name is not None:
            info.append(self.meth_name)

        if self._source_traceback is not None:
            frame = self._source_traceback[-1]
            info.append('created at {}:{}'.format(frame[0], frame[1]))

        return '<' + ' '.join(info) + '>'

    def cancel(self):
        self._cancel()

    def cancelled(self):
        return self._cancelled


@cython.no_gc_clear
@cython.freelist(DEFAULT_FREELIST_SIZE)
cdef class TimerHandle:
    def __cinit__(self, Loop loop, object callback, object args,
                  uint64_t delay, object context):

        self.loop = loop
        self.callback = callback
        self.args = args
        self._cancelled = 0

        if UVLOOP_DEBUG:
            self.loop._debug_cb_timer_handles_total += 1
            self.loop._debug_cb_timer_handles_count += 1

        if context is None:
            context = Context_CopyCurrent()
        self.context = context

        if loop._debug:
            self._debug_info = (
                format_callback_name(callback),
                extract_stack()
            )
        else:
            self._debug_info = None

        self.timer = UVTimer.new(
            loop, <method_t>self._run, self, delay)

        self.timer.start()
        self._when = self.timer.get_when() * 1e-3

        # Only add to loop._timers when `self.timer` is successfully created
        loop._timers.add(self)

    property _source_traceback:
        def __get__(self):
            if self._debug_info is not None:
                return self._debug_info[1]

    def __dealloc__(self):
        if UVLOOP_DEBUG:
            self.loop._debug_cb_timer_handles_count -= 1
        if self.timer is not None:
            raise RuntimeError('active TimerHandle is deallacating')

    cdef _cancel(self):
        if self._cancelled == 1:
            return
        self._cancelled = 1
        self._clear()

    cdef inline _clear(self):
        if self.timer is None:
            return

        self.callback = None
        self.args = None

        try:
            self.loop._timers.remove(self)
        finally:
            self.timer._close()
            self.timer = None  # let the UVTimer handle GC

    cdef _run(self):
        if self._cancelled == 1:
            return
        if self.callback is None:
            raise RuntimeError('cannot run TimerHandle; callback is not set')

        callback = self.callback
        args = self.args

        # Since _run is a cdef and there's no BoundMethod,
        # we guard 'self' manually.
        Py_INCREF(self)

        if self.loop._debug:
            started = time_monotonic()
        try:
            assert self.context is not None
            Context_Enter(self.context)

            if args is not None:
                callback(*args)
            else:
                callback()
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as ex:
            context = {
                'message': 'Exception in callback {}'.format(callback),
                'exception': ex,
                'handle': self,
            }

            if self._debug_info is not None:
                context['source_traceback'] = self._debug_info[1]

            self.loop.call_exception_handler(context)
        else:
            if self.loop._debug:
                delta = time_monotonic() - started
                if delta > self.loop.slow_callback_duration:
                    aio_logger.warning(
                        'Executing %r took %.3f seconds',
                        self, delta)
        finally:
            context = self.context
            Py_DECREF(self)
            Context_Exit(context)
            self._clear()

    # Public API

    def __repr__(self):
        info = [self.__class__.__name__]

        if self._cancelled:
            info.append('cancelled')

        if self._debug_info is not None:
            callback_name = self._debug_info[0]
            source_traceback = self._debug_info[1]
        else:
            callback_name = None
            source_traceback = None

        if callback_name is not None:
            info.append(callback_name)
        elif self.callback is not None:
            info.append(format_callback_name(self.callback))

        if source_traceback is not None:
            frame = source_traceback[-1]
            info.append('created at {}:{}'.format(frame[0], frame[1]))

        return '<' + ' '.join(info) + '>'

    def cancelled(self):
        return self._cancelled

    def cancel(self):
        self._cancel()

    def when(self):
        return self._when


cdef format_callback_name(func):
    if hasattr(func, '__qualname__'):
        cb_name = getattr(func, '__qualname__')
    elif hasattr(func, '__name__'):
        cb_name = getattr(func, '__name__')
    else:
        cb_name = repr(func)
    return cb_name


cdef new_Handle(Loop loop, object callback, object args, object context):
    cdef Handle handle
    handle = Handle.__new__(Handle)
    handle._set_loop(loop)
    handle._set_context(context)

    handle.cb_type = 1

    handle.arg1 = callback
    handle.arg2 = args

    return handle


cdef new_MethodHandle(Loop loop, str name, method_t callback, object context,
                      object bound_to):
    cdef Handle handle
    handle = Handle.__new__(Handle)
    handle._set_loop(loop)
    handle._set_context(context)

    handle.cb_type = 2
    handle.meth_name = name

    handle.callback = <void*> callback
    handle.arg1 = bound_to

    return handle


cdef new_MethodHandle1(Loop loop, str name, method1_t callback, object context,
                       object bound_to, object arg):

    cdef Handle handle
    handle = Handle.__new__(Handle)
    handle._set_loop(loop)
    handle._set_context(context)

    handle.cb_type = 3
    handle.meth_name = name

    handle.callback = <void*> callback
    handle.arg1 = bound_to
    handle.arg2 = arg

    return handle


cdef new_MethodHandle2(Loop loop, str name, method2_t callback, object context,
                       object bound_to, object arg1, object arg2):

    cdef Handle handle
    handle = Handle.__new__(Handle)
    handle._set_loop(loop)
    handle._set_context(context)

    handle.cb_type = 4
    handle.meth_name = name

    handle.callback = <void*> callback
    handle.arg1 = bound_to
    handle.arg2 = arg1
    handle.arg3 = arg2

    return handle


cdef new_MethodHandle3(Loop loop, str name, method3_t callback, object context,
                       object bound_to, object arg1, object arg2, object arg3):

    cdef Handle handle
    handle = Handle.__new__(Handle)
    handle._set_loop(loop)
    handle._set_context(context)

    handle.cb_type = 5
    handle.meth_name = name

    handle.callback = <void*> callback
    handle.arg1 = bound_to
    handle.arg2 = arg1
    handle.arg3 = arg2
    handle.arg4 = arg3

    return handle


cdef extract_stack():
    """Replacement for traceback.extract_stack() that only does the
    necessary work for asyncio debug mode.
    """
    try:
        f = sys_getframe()
    # sys._getframe() might raise ValueError if being called without a frame, e.g.
    # from Cython or similar C extensions.
    except ValueError:
        return None
    if f is None:
        return

    try:
        stack = tb_StackSummary.extract(tb_walk_stack(f),
                                        limit=DEBUG_STACK_DEPTH,
                                        lookup_lines=False)
    finally:
        f = None

    stack.reverse()
    return stack
