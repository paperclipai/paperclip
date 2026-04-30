from typing import Union
from array import array

class URL:
    schema: bytes
    host: bytes
    port: int
    path: bytes
    query: bytes
    fragment: bytes
    userinfo: bytes

def parse_url(url: Union[bytes, bytearray, memoryview, array]) -> URL:
    """Parse URL strings into a structured Python object.

    Returns an instance of ``httptools.URL`` class with the
    following attributes:

      - schema: bytes
      - host: bytes
      - port: int
      - path: bytes
      - query: bytes
      - fragment: bytes
      - userinfo: bytes
    """
    ...
