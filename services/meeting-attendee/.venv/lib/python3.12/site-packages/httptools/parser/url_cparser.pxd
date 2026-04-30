from libc.stdint cimport uint16_t


cdef extern from "http_parser.h":
    # URL Parser

    enum http_parser_url_fields:
        UF_SCHEMA   = 0,
        UF_HOST     = 1,
        UF_PORT     = 2,
        UF_PATH     = 3,
        UF_QUERY    = 4,
        UF_FRAGMENT = 5,
        UF_USERINFO = 6,
        UF_MAX      = 7

    struct http_parser_url_field_data:
        uint16_t off
        uint16_t len

    struct http_parser_url:
        uint16_t field_set
        uint16_t port
        http_parser_url_field_data[<int>UF_MAX] field_data

    void http_parser_url_init(http_parser_url *u)

    int http_parser_parse_url(const char *buf,
                              size_t buflen,
                              int is_connect,
                              http_parser_url *u)
