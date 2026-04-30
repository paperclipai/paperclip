#cython: language_level=3

from __future__ import print_function
from cpython.mem cimport PyMem_Malloc, PyMem_Free
from cpython cimport PyObject_GetBuffer, PyBuffer_Release, PyBUF_SIMPLE, \
                     Py_buffer

from .errors import HttpParserInvalidURLError

cimport cython
from . cimport url_cparser as uparser

__all__ = ('parse_url',)

@cython.freelist(250)
cdef class URL:
    cdef readonly bytes schema
    cdef readonly bytes host
    cdef readonly object port
    cdef readonly bytes path
    cdef readonly bytes query
    cdef readonly bytes fragment
    cdef readonly bytes userinfo

    def __cinit__(self, bytes schema, bytes host, object port, bytes path,
                  bytes query, bytes fragment, bytes userinfo):

        self.schema = schema
        self.host = host
        self.port = port
        self.path = path
        self.query = query
        self.fragment = fragment
        self.userinfo = userinfo

    def __repr__(self):
        return ('<URL schema: {!r}, host: {!r}, port: {!r}, path: {!r}, '
                'query: {!r}, fragment: {!r}, userinfo: {!r}>'
                .format(self.schema, self.host, self.port, self.path,
                    self.query, self.fragment, self.userinfo))


def parse_url(url):
    cdef:
        Py_buffer py_buf
        char* buf_data
        uparser.http_parser_url* parsed
        int res
        bytes schema = None
        bytes host = None
        object port = None
        bytes path = None
        bytes query = None
        bytes fragment = None
        bytes userinfo = None
        object result = None
        int off
        int ln

    parsed = <uparser.http_parser_url*> \
                        PyMem_Malloc(sizeof(uparser.http_parser_url))
    uparser.http_parser_url_init(parsed)

    PyObject_GetBuffer(url, &py_buf, PyBUF_SIMPLE)
    try:
        buf_data = <char*>py_buf.buf
        res = uparser.http_parser_parse_url(buf_data, py_buf.len, 0, parsed)

        if res == 0:
            if parsed.field_set & (1 << uparser.UF_SCHEMA):
                off = parsed.field_data[<int>uparser.UF_SCHEMA].off
                ln = parsed.field_data[<int>uparser.UF_SCHEMA].len
                schema = buf_data[off:off+ln]

            if parsed.field_set & (1 << uparser.UF_HOST):
                off = parsed.field_data[<int>uparser.UF_HOST].off
                ln = parsed.field_data[<int>uparser.UF_HOST].len
                host = buf_data[off:off+ln]

            if parsed.field_set & (1 << uparser.UF_PORT):
                port = parsed.port

            if parsed.field_set & (1 << uparser.UF_PATH):
                off = parsed.field_data[<int>uparser.UF_PATH].off
                ln = parsed.field_data[<int>uparser.UF_PATH].len
                path = buf_data[off:off+ln]

            if parsed.field_set & (1 << uparser.UF_QUERY):
                off = parsed.field_data[<int>uparser.UF_QUERY].off
                ln = parsed.field_data[<int>uparser.UF_QUERY].len
                query = buf_data[off:off+ln]

            if parsed.field_set & (1 << uparser.UF_FRAGMENT):
                off = parsed.field_data[<int>uparser.UF_FRAGMENT].off
                ln = parsed.field_data[<int>uparser.UF_FRAGMENT].len
                fragment = buf_data[off:off+ln]

            if parsed.field_set & (1 << uparser.UF_USERINFO):
                off = parsed.field_data[<int>uparser.UF_USERINFO].off
                ln = parsed.field_data[<int>uparser.UF_USERINFO].len
                userinfo = buf_data[off:off+ln]

            return URL(schema, host, port, path, query, fragment, userinfo)
        else:
            raise HttpParserInvalidURLError("invalid url {!r}".format(url))
    finally:
        PyBuffer_Release(&py_buf)
        PyMem_Free(parsed)
