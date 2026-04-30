"""Test utilities. Don't use outside of the uvloop project."""


import asyncio
import asyncio.events
import collections
import contextlib
import gc
import logging
import os
import pprint
import re
import select
import socket
import ssl
import sys
import tempfile
import threading
import time
import unittest
import uvloop


class MockPattern(str):
    def __eq__(self, other):
        return bool(re.search(str(self), other, re.S))


class TestCaseDict(collections.UserDict):

    def __init__(self, name):
        super().__init__()
        self.name = name

    def __setitem__(self, key, value):
        if key in self.data:
            raise RuntimeError('duplicate test {}.{}'.format(
                self.name, key))
        super().__setitem__(key, value)


class BaseTestCaseMeta(type):

    @classmethod
    def __prepare__(mcls, name, bases):
        return TestCaseDict(name)

    def __new__(mcls, name, bases, dct):
        for test_name in dct:
            if not test_name.startswith('test_'):
                continue
            for base in bases:
                if hasattr(base, test_name):
                    raise RuntimeError(
                        'duplicate test {}.{} (also defined in {} '
                        'parent class)'.format(
                            name, test_name, base.__name__))

        return super().__new__(mcls, name, bases, dict(dct))


class BaseTestCase(unittest.TestCase, metaclass=BaseTestCaseMeta):

    def new_loop(self):
        raise NotImplementedError

    def new_policy(self):
        raise NotImplementedError

    def mock_pattern(self, str):
        return MockPattern(str)

    async def wait_closed(self, obj):
        if not isinstance(obj, asyncio.StreamWriter):
            return
        try:
            await obj.wait_closed()
        except (BrokenPipeError, ConnectionError):
            pass

    def is_asyncio_loop(self):
        return type(self.loop).__module__.startswith('asyncio.')

    def run_loop_briefly(self, *, delay=0.01):
        self.loop.run_until_complete(asyncio.sleep(delay))

    def loop_exception_handler(self, loop, context):
        self.__unhandled_exceptions.append(context)
        self.loop.default_exception_handler(context)

    def setUp(self):
        self.loop = self.new_loop()
        asyncio.set_event_loop_policy(self.new_policy())
        asyncio.set_event_loop(self.loop)
        self._check_unclosed_resources_in_debug = True

        self.loop.set_exception_handler(self.loop_exception_handler)
        self.__unhandled_exceptions = []

    def tearDown(self):
        self.loop.close()

        if self.__unhandled_exceptions:
            print('Unexpected calls to loop.call_exception_handler():')
            pprint.pprint(self.__unhandled_exceptions)
            self.fail('unexpected calls to loop.call_exception_handler()')
            return

        if not self._check_unclosed_resources_in_debug:
            return

        # GC to show any resource warnings as the test completes
        gc.collect()
        gc.collect()
        gc.collect()

        if getattr(self.loop, '_debug_cc', False):
            gc.collect()
            gc.collect()
            gc.collect()

            self.assertEqual(
                self.loop._debug_uv_handles_total,
                self.loop._debug_uv_handles_freed,
                'not all uv_handle_t handles were freed')

            self.assertEqual(
                self.loop._debug_cb_handles_count, 0,
                'not all callbacks (call_soon) are GCed')

            self.assertEqual(
                self.loop._debug_cb_timer_handles_count, 0,
                'not all timer callbacks (call_later) are GCed')

            self.assertEqual(
                self.loop._debug_stream_write_ctx_cnt, 0,
                'not all stream write contexts are GCed')

            for h_name, h_cnt in self.loop._debug_handles_current.items():
                with self.subTest('Alive handle after test',
                                  handle_name=h_name):
                    self.assertEqual(
                        h_cnt, 0,
                        'alive {} after test'.format(h_name))

            for h_name, h_cnt in self.loop._debug_handles_total.items():
                with self.subTest('Total/closed handles',
                                  handle_name=h_name):
                    self.assertEqual(
                        h_cnt, self.loop._debug_handles_closed[h_name],
                        'total != closed for {}'.format(h_name))

        asyncio.set_event_loop(None)
        asyncio.set_event_loop_policy(None)
        self.loop = None

    def skip_unclosed_handles_check(self):
        self._check_unclosed_resources_in_debug = False

    def tcp_server(self, server_prog, *,
                   family=socket.AF_INET,
                   addr=None,
                   timeout=5,
                   backlog=1,
                   max_clients=10):

        if addr is None:
            if family == socket.AF_UNIX:
                with tempfile.NamedTemporaryFile() as tmp:
                    addr = tmp.name
            else:
                addr = ('127.0.0.1', 0)

        sock = socket.socket(family, socket.SOCK_STREAM)

        if timeout is None:
            raise RuntimeError('timeout is required')
        if timeout <= 0:
            raise RuntimeError('only blocking sockets are supported')
        sock.settimeout(timeout)

        try:
            sock.bind(addr)
            sock.listen(backlog)
        except OSError as ex:
            sock.close()
            raise ex

        return TestThreadedServer(
            self, sock, server_prog, timeout, max_clients)

    def tcp_client(self, client_prog,
                   family=socket.AF_INET,
                   timeout=10):

        sock = socket.socket(family, socket.SOCK_STREAM)

        if timeout is None:
            raise RuntimeError('timeout is required')
        if timeout <= 0:
            raise RuntimeError('only blocking sockets are supported')
        sock.settimeout(timeout)

        return TestThreadedClient(
            self, sock, client_prog, timeout)

    def unix_server(self, *args, **kwargs):
        return self.tcp_server(*args, family=socket.AF_UNIX, **kwargs)

    def unix_client(self, *args, **kwargs):
        return self.tcp_client(*args, family=socket.AF_UNIX, **kwargs)

    @contextlib.contextmanager
    def unix_sock_name(self):
        with tempfile.TemporaryDirectory() as td:
            fn = os.path.join(td, 'sock')
            try:
                yield fn
            finally:
                try:
                    os.unlink(fn)
                except OSError:
                    pass

    def _abort_socket_test(self, ex):
        try:
            self.loop.stop()
        finally:
            self.fail(ex)


def _cert_fullname(test_file_name, cert_file_name):
    fullname = os.path.abspath(os.path.join(
        os.path.dirname(test_file_name), 'certs', cert_file_name))
    assert os.path.isfile(fullname)
    return fullname


@contextlib.contextmanager
def silence_long_exec_warning():

    class Filter(logging.Filter):
        def filter(self, record):
            return not (record.msg.startswith('Executing') and
                        record.msg.endswith('seconds'))

    logger = logging.getLogger('asyncio')
    filter = Filter()
    logger.addFilter(filter)
    try:
        yield
    finally:
        logger.removeFilter(filter)


def find_free_port(start_from=50000):
    for port in range(start_from, start_from + 500):
        sock = socket.socket()
        with sock:
            try:
                sock.bind(('', port))
            except socket.error:
                continue
            else:
                return port
    raise RuntimeError('could not find a free port')


class SSLTestCase:

    def _create_server_ssl_context(self, certfile, keyfile=None):
        if hasattr(ssl, 'PROTOCOL_TLS_SERVER'):
            sslcontext = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        elif hasattr(ssl, 'PROTOCOL_TLS'):
            sslcontext = ssl.SSLContext(ssl.PROTOCOL_TLS)
        else:
            sslcontext = ssl.SSLContext(ssl.PROTOCOL_SSLv23)
        sslcontext.options |= ssl.OP_NO_SSLv2
        sslcontext.load_cert_chain(certfile, keyfile)
        return sslcontext

    def _create_client_ssl_context(self, *, disable_verify=True):
        sslcontext = ssl.create_default_context()
        sslcontext.check_hostname = False
        if disable_verify:
            sslcontext.verify_mode = ssl.CERT_NONE
        return sslcontext

    @contextlib.contextmanager
    def _silence_eof_received_warning(self):
        # TODO This warning has to be fixed in asyncio.
        logger = logging.getLogger('asyncio')
        filter = logging.Filter('has no effect when using ssl')
        logger.addFilter(filter)
        try:
            yield
        finally:
            logger.removeFilter(filter)


class UVTestCase(BaseTestCase):

    implementation = 'uvloop'

    def new_loop(self):
        return uvloop.new_event_loop()

    def new_policy(self):
        return uvloop.EventLoopPolicy()


class AIOTestCase(BaseTestCase):

    implementation = 'asyncio'

    def setUp(self):
        super().setUp()

        if sys.version_info < (3, 12):
            watcher = asyncio.SafeChildWatcher()
            watcher.attach_loop(self.loop)
            asyncio.set_child_watcher(watcher)

    def tearDown(self):
        if sys.version_info < (3, 12):
            asyncio.set_child_watcher(None)
        super().tearDown()

    def new_loop(self):
        return asyncio.new_event_loop()

    def new_policy(self):
        return asyncio.DefaultEventLoopPolicy()


def has_IPv6():
    server_sock = socket.socket(socket.AF_INET6)
    with server_sock:
        try:
            server_sock.bind(('::1', 0))
        except OSError:
            return False
        else:
            return True


has_IPv6 = has_IPv6()


###############################################################################
# Socket Testing Utilities
###############################################################################


class TestSocketWrapper:

    def __init__(self, sock):
        self.__sock = sock

    def recv_all(self, n):
        buf = b''
        while len(buf) < n:
            data = self.recv(n - len(buf))
            if data == b'':
                raise ConnectionAbortedError
            buf += data
        return buf

    def starttls(self, ssl_context, *,
                 server_side=False,
                 server_hostname=None,
                 do_handshake_on_connect=True):

        assert isinstance(ssl_context, ssl.SSLContext)

        ssl_sock = ssl_context.wrap_socket(
            self.__sock, server_side=server_side,
            server_hostname=server_hostname,
            do_handshake_on_connect=do_handshake_on_connect)

        if server_side:
            ssl_sock.do_handshake()

        self.__sock.close()
        self.__sock = ssl_sock

    def __getattr__(self, name):
        return getattr(self.__sock, name)

    def __repr__(self):
        return '<{} {!r}>'.format(type(self).__name__, self.__sock)


class SocketThread(threading.Thread):

    def stop(self):
        self._active = False
        self.join()

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()


class TestThreadedClient(SocketThread):

    def __init__(self, test, sock, prog, timeout):
        threading.Thread.__init__(self, None, None, 'test-client')
        self.daemon = True

        self._timeout = timeout
        self._sock = sock
        self._active = True
        self._prog = prog
        self._test = test

    def run(self):
        try:
            self._prog(TestSocketWrapper(self._sock))
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as ex:
            self._test._abort_socket_test(ex)


class TestThreadedServer(SocketThread):

    def __init__(self, test, sock, prog, timeout, max_clients):
        threading.Thread.__init__(self, None, None, 'test-server')
        self.daemon = True

        self._clients = 0
        self._finished_clients = 0
        self._max_clients = max_clients
        self._timeout = timeout
        self._sock = sock
        self._active = True

        self._prog = prog

        self._s1, self._s2 = socket.socketpair()
        self._s1.setblocking(False)

        self._test = test

    def stop(self):
        try:
            if self._s2 and self._s2.fileno() != -1:
                try:
                    self._s2.send(b'stop')
                except OSError:
                    pass
        finally:
            super().stop()

    def run(self):
        try:
            with self._sock:
                self._sock.setblocking(0)
                self._run()
        finally:
            self._s1.close()
            self._s2.close()

    def _run(self):
        while self._active:
            if self._clients >= self._max_clients:
                return

            r, w, x = select.select(
                [self._sock, self._s1], [], [], self._timeout)

            if self._s1 in r:
                return

            if self._sock in r:
                try:
                    conn, addr = self._sock.accept()
                except BlockingIOError:
                    continue
                except socket.timeout:
                    if not self._active:
                        return
                    else:
                        raise
                else:
                    self._clients += 1
                    conn.settimeout(self._timeout)
                    try:
                        with conn:
                            self._handle_client(conn)
                    except (KeyboardInterrupt, SystemExit):
                        raise
                    except BaseException as ex:
                        self._active = False
                        try:
                            raise
                        finally:
                            self._test._abort_socket_test(ex)

    def _handle_client(self, sock):
        self._prog(TestSocketWrapper(sock))

    @property
    def addr(self):
        return self._sock.getsockname()


###############################################################################
# A few helpers from asyncio/tests/testutils.py
###############################################################################


def run_briefly(loop):
    async def once():
        pass
    gen = once()
    t = loop.create_task(gen)
    # Don't log a warning if the task is not done after run_until_complete().
    # It occurs if the loop is stopped or if a task raises a BaseException.
    t._log_destroy_pending = False
    try:
        loop.run_until_complete(t)
    finally:
        gen.close()


def run_until(loop, pred, timeout=30):
    deadline = time.time() + timeout
    while not pred():
        if timeout is not None:
            timeout = deadline - time.time()
            if timeout <= 0:
                raise asyncio.futures.TimeoutError()
        loop.run_until_complete(asyncio.tasks.sleep(0.001))


@contextlib.contextmanager
def disable_logger():
    """Context manager to disable asyncio logger.

    For example, it can be used to ignore warnings in debug mode.
    """
    old_level = asyncio.log.logger.level
    try:
        asyncio.log.logger.setLevel(logging.CRITICAL + 1)
        yield
    finally:
        asyncio.log.logger.setLevel(old_level)
