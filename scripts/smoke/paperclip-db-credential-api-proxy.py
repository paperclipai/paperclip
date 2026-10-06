#!/usr/bin/env python3
"""Expose the disposable loopback API only on its private Docker test bridge."""

import select
import socket
import sys
import threading
from pathlib import Path


def forward(client: socket.socket, upstream_port: int) -> None:
    with client:
        with socket.create_connection(("127.0.0.1", upstream_port), timeout=5) as upstream:
            peers = (client, upstream)
            while True:
                readable, _, _ = select.select(peers, [], [], 30)
                if not readable:
                    return
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is client else client).sendall(data)


def main() -> None:
    bridge_ip, upstream_port, port_file = sys.argv[1:]
    with socket.create_server((bridge_ip, 0), backlog=8) as listener:
        Path(port_file).write_text(str(listener.getsockname()[1]), encoding="ascii")
        while True:
            client, _ = listener.accept()
            threading.Thread(target=forward, args=(client, int(upstream_port)), daemon=True).start()


if __name__ == "__main__":
    main()
