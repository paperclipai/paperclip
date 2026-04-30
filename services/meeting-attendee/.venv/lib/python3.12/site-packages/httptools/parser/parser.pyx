#cython: language_level=3

from __future__ import print_function
from typing import Optional

from cpython.mem cimport PyMem_Malloc, PyMem_Free
from cpython cimport PyObject_GetBuffer, PyBuffer_Release, PyBUF_SIMPLE, \
                     Py_buffer, PyBytes_AsString

from .python cimport PyMemoryView_Check, PyMemoryView_GET_BUFFER


from .errors import (HttpParserError,
                     HttpParserCallbackError,
                     HttpParserInvalidStatusError,
                     HttpParserInvalidMethodError,
                     HttpParserInvalidURLError,
                     HttpParserUpgrade)

cimport cython
from . cimport cparser


__all__ = ('HttpRequestParser', 'HttpResponseParser')


@cython.internal
cdef class HttpParser:

    cdef:
        cparser.llhttp_t* _cparser
        cparser.llhttp_settings_t* _csettings

        bytes _current_header_name
        bytes _current_header_value

        _proto_on_url, _proto_on_status, _proto_on_body, \
        _proto_on_header, _proto_on_headers_complete, \
        _proto_on_message_complete, _proto_on_chunk_header, \
        _proto_on_chunk_complete, _proto_on_message_begin

        object _last_error

        Py_buffer py_buf

    def __cinit__(self):
        self._cparser = <cparser.llhttp_t*> \
                                PyMem_Malloc(sizeof(cparser.llhttp_t))
        if self._cparser is NULL:
            raise MemoryError()

        self._csettings = <cparser.llhttp_settings_t*> \
                                PyMem_Malloc(sizeof(cparser.llhttp_settings_t))
        if self._csettings is NULL:
            raise MemoryError()

    def __dealloc__(self):
        PyMem_Free(self._cparser)
        PyMem_Free(self._csettings)

    cdef _init(self, protocol, cparser.llhttp_type_t mode):
        cparser.llhttp_settings_init(self._csettings)

        cparser.llhttp_init(self._cparser, mode, self._csettings)
        self._cparser.data = <void*>self

        self._current_header_name = None
        self._current_header_value = None

        self._proto_on_header = getattr(protocol, 'on_header', None)
        if self._proto_on_header is not None:
            self._csettings.on_header_field = cb_on_header_field
            self._csettings.on_header_value = cb_on_header_value
        self._proto_on_headers_complete = getattr(
            protocol, 'on_headers_complete', None)
        self._csettings.on_headers_complete = cb_on_headers_complete

        self._proto_on_body = getattr(protocol, 'on_body', None)
        if self._proto_on_body is not None:
            self._csettings.on_body = cb_on_body

        self._proto_on_message_begin = getattr(
            protocol, 'on_message_begin', None)
        if self._proto_on_message_begin is not None:
            self._csettings.on_message_begin = cb_on_message_begin

        self._proto_on_message_complete = getattr(
            protocol, 'on_message_complete', None)
        if self._proto_on_message_complete is not None:
            self._csettings.on_message_complete = cb_on_message_complete

        self._proto_on_chunk_header = getattr(
            protocol, 'on_chunk_header', None)
        self._csettings.on_chunk_header = cb_on_chunk_header

        self._proto_on_chunk_complete = getattr(
            protocol, 'on_chunk_complete', None)
        self._csettings.on_chunk_complete = cb_on_chunk_complete

        self._last_error = None

    cdef _maybe_call_on_header(self):
        if self._current_header_value is not None:
            current_header_name = self._current_header_name
            current_header_value = self._current_header_value

            self._current_header_name = self._current_header_value = None

            if self._proto_on_header is not None:
                self._proto_on_header(current_header_name,
                                      current_header_value)

    cdef _on_header_field(self, bytes field):
        self._maybe_call_on_header()
        if self._current_header_name is None:
            self._current_header_name = field
        else:
            self._current_header_name += field

    cdef _on_header_value(self, bytes val):
        if self._current_header_value is None:
            self._current_header_value = val
        else:
            # This is unlikely, as mostly HTTP headers are one-line
            self._current_header_value += val

    cdef _on_headers_complete(self):
        self._maybe_call_on_header()

        if self._proto_on_headers_complete is not None:
            self._proto_on_headers_complete()

    cdef _on_chunk_header(self):
        if (self._current_header_value is not None or
            self._current_header_name is not None):
            raise HttpParserError('invalid headers state')

        if self._proto_on_chunk_header is not None:
            self._proto_on_chunk_header()

    cdef _on_chunk_complete(self):
        self._maybe_call_on_header()

        if self._proto_on_chunk_complete is not None:
            self._proto_on_chunk_complete()

    ### Public API ###

    def set_dangerous_leniencies(
        self,
        lenient_headers: Optional[bool] = None,
        lenient_chunked_length: Optional[bool] = None,
        lenient_keep_alive: Optional[bool] = None,
        lenient_transfer_encoding: Optional[bool] = None,
        lenient_version: Optional[bool] = None,
        lenient_data_after_close: Optional[bool] = None,
        lenient_optional_lf_after_cr: Optional[bool] = None,
        lenient_optional_cr_before_lf: Optional[bool] = None,
        lenient_optional_crlf_after_chunk: Optional[bool] = None,
        lenient_spaces_after_chunk_size: Optional[bool] = None,
    ):
        cdef cparser.llhttp_t* parser = self._cparser
        if lenient_headers is not None:
            cparser.llhttp_set_lenient_headers(
                parser, lenient_headers)
        if lenient_chunked_length is not None:
            cparser.llhttp_set_lenient_chunked_length(
                parser, lenient_chunked_length)
        if lenient_keep_alive is not None:
            cparser.llhttp_set_lenient_keep_alive(
                parser, lenient_keep_alive)
        if lenient_transfer_encoding is not None:
            cparser.llhttp_set_lenient_transfer_encoding(
                parser, lenient_transfer_encoding)
        if lenient_version is not None:
            cparser.llhttp_set_lenient_version(
                parser, lenient_version)
        if lenient_data_after_close is not None:
            cparser.llhttp_set_lenient_data_after_close(
                parser, lenient_data_after_close)
        if lenient_optional_lf_after_cr is not None:
            cparser.llhttp_set_lenient_optional_lf_after_cr(
                parser, lenient_optional_lf_after_cr)
        if lenient_optional_cr_before_lf is not None:
            cparser.llhttp_set_lenient_optional_cr_before_lf(
                parser, lenient_optional_cr_before_lf)
        if lenient_optional_crlf_after_chunk is not None:
            cparser.llhttp_set_lenient_optional_crlf_after_chunk(
                parser, lenient_optional_crlf_after_chunk)
        if lenient_spaces_after_chunk_size is not None:
            cparser.llhttp_set_lenient_spaces_after_chunk_size(
                parser, lenient_spaces_after_chunk_size)

    def get_http_version(self):
        cdef cparser.llhttp_t* parser = self._cparser
        return '{}.{}'.format(parser.http_major, parser.http_minor)

    def should_keep_alive(self):
        return bool(cparser.llhttp_should_keep_alive(self._cparser))

    def should_upgrade(self):
        cdef cparser.llhttp_t* parser = self._cparser
        return bool(parser.upgrade)

    def feed_data(self, data):
        cdef:
            size_t data_len
            cparser.llhttp_errno_t err
            Py_buffer *buf
            bint owning_buf = False
            const char* err_pos

        if PyMemoryView_Check(data):
            buf = PyMemoryView_GET_BUFFER(data)
            data_len = <size_t>buf.len
            err = cparser.llhttp_execute(
                self._cparser,
                <char*>buf.buf,
                data_len)

        else:
            buf = &self.py_buf
            PyObject_GetBuffer(data, buf, PyBUF_SIMPLE)
            owning_buf = True
            data_len = <size_t>buf.len

            err = cparser.llhttp_execute(
                self._cparser,
                <char*>buf.buf,
                data_len)

        try:
            if self._cparser.upgrade == 1 and err == cparser.HPE_PAUSED_UPGRADE:
                err_pos = cparser.llhttp_get_error_pos(self._cparser)

                # Immediately free the parser from "error" state, simulating
                # http-parser behavior here because 1) we never had the API to
                # allow users manually "resume after upgrade", and 2) the use
                # case for resuming parsing is very rare.
                cparser.llhttp_resume_after_upgrade(self._cparser)

                # The err_pos here is specific for the input buf. So if we ever
                # switch to the llhttp behavior (re-raise HttpParserUpgrade for
                # successive calls to feed_data() until resume_after_upgrade is
                # called), we have to store the result and keep our own state.
                raise HttpParserUpgrade(err_pos - <char*>buf.buf)
        finally:
            if owning_buf:
                PyBuffer_Release(buf)

        if err != cparser.HPE_OK:
            ex = parser_error_from_errno(
                self._cparser,
                <cparser.llhttp_errno_t> self._cparser.error)
            if isinstance(ex, HttpParserCallbackError):
                if self._last_error is not None:
                    ex.__context__ = self._last_error
                    self._last_error = None
            raise ex


cdef class HttpRequestParser(HttpParser):

    def __init__(self, protocol):
        self._init(protocol, cparser.HTTP_REQUEST)

        self._proto_on_url = getattr(protocol, 'on_url', None)
        if self._proto_on_url is not None:
            self._csettings.on_url = cb_on_url

    def get_method(self):
        cdef cparser.llhttp_t* parser = self._cparser
        return cparser.llhttp_method_name(<cparser.llhttp_method_t> parser.method)


cdef class HttpResponseParser(HttpParser):

    def __init__(self, protocol):
        self._init(protocol, cparser.HTTP_RESPONSE)

        self._proto_on_status = getattr(protocol, 'on_status', None)
        if self._proto_on_status is not None:
            self._csettings.on_status = cb_on_status

    def get_status_code(self):
        cdef cparser.llhttp_t* parser = self._cparser
        return parser.status_code


cdef int cb_on_message_begin(cparser.llhttp_t* parser) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._proto_on_message_begin()
    except BaseException as ex:
        pyparser._last_error = ex
        return -1
    else:
        return 0


cdef int cb_on_url(cparser.llhttp_t* parser,
                   const char *at, size_t length) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._proto_on_url(at[:length])
    except BaseException as ex:
        cparser.llhttp_set_error_reason(parser, "`on_url` callback error")
        pyparser._last_error = ex
        return cparser.HPE_USER
    else:
        return 0


cdef int cb_on_status(cparser.llhttp_t* parser,
                      const char *at, size_t length) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._proto_on_status(at[:length])
    except BaseException as ex:
        cparser.llhttp_set_error_reason(parser, "`on_status` callback error")
        pyparser._last_error = ex
        return cparser.HPE_USER
    else:
        return 0


cdef int cb_on_header_field(cparser.llhttp_t* parser,
                            const char *at, size_t length) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._on_header_field(at[:length])
    except BaseException as ex:
        cparser.llhttp_set_error_reason(parser, "`on_header_field` callback error")
        pyparser._last_error = ex
        return cparser.HPE_USER
    else:
        return 0


cdef int cb_on_header_value(cparser.llhttp_t* parser,
                            const char *at, size_t length) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._on_header_value(at[:length])
    except BaseException as ex:
        cparser.llhttp_set_error_reason(parser, "`on_header_value` callback error")
        pyparser._last_error = ex
        return cparser.HPE_USER
    else:
        return 0


cdef int cb_on_headers_complete(cparser.llhttp_t* parser) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._on_headers_complete()
    except BaseException as ex:
        pyparser._last_error = ex
        return -1
    else:
        if pyparser._cparser.upgrade:
            return 1
        else:
            return 0


cdef int cb_on_body(cparser.llhttp_t* parser,
                    const char *at, size_t length) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._proto_on_body(at[:length])
    except BaseException as ex:
        cparser.llhttp_set_error_reason(parser, "`on_body` callback error")
        pyparser._last_error = ex
        return cparser.HPE_USER
    else:
        return 0


cdef int cb_on_message_complete(cparser.llhttp_t* parser) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._proto_on_message_complete()
    except BaseException as ex:
        pyparser._last_error = ex
        return -1
    else:
        return 0


cdef int cb_on_chunk_header(cparser.llhttp_t* parser) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._on_chunk_header()
    except BaseException as ex:
        pyparser._last_error = ex
        return -1
    else:
        return 0


cdef int cb_on_chunk_complete(cparser.llhttp_t* parser) except -1:
    cdef HttpParser pyparser = <HttpParser>parser.data
    try:
        pyparser._on_chunk_complete()
    except BaseException as ex:
        pyparser._last_error = ex
        return -1
    else:
        return 0


cdef parser_error_from_errno(cparser.llhttp_t* parser, cparser.llhttp_errno_t errno):
    cdef bytes reason = cparser.llhttp_get_error_reason(parser)

    if errno in (cparser.HPE_CB_MESSAGE_BEGIN,
                 cparser.HPE_CB_HEADERS_COMPLETE,
                 cparser.HPE_CB_MESSAGE_COMPLETE,
                 cparser.HPE_CB_CHUNK_HEADER,
                 cparser.HPE_CB_CHUNK_COMPLETE,
                 cparser.HPE_USER):
        cls = HttpParserCallbackError

    elif errno == cparser.HPE_INVALID_STATUS:
        cls = HttpParserInvalidStatusError

    elif errno == cparser.HPE_INVALID_METHOD:
        cls = HttpParserInvalidMethodError

    elif errno == cparser.HPE_INVALID_URL:
        cls = HttpParserInvalidURLError

    else:
        cls = HttpParserError

    return cls(reason.decode('latin-1'))
