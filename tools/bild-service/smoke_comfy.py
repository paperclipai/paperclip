#!/usr/bin/env python3
"""Rauchtest Ende zu Ende gegen den echten Knoten. Kein pytest — manuell.

Aufruf: /usr/bin/python3 smoke_comfy.py
"""
import sys
import time

import comfy_client as cc
import workflow_template as wt

if not cc.health():
    sys.exit("Knoten %s antwortet nicht." % cc.COMFY_BASE)

wf = wt.fill(wt.load_raw("qwen-image"),
             "Ein weisser Hirsch im Morgennebel, fotorealistisch", 42, 1024, 1024)
t0 = time.time()
pid = cc.submit(wf)
print("abgesendet:", pid)

while time.time() - t0 < 300:
    time.sleep(2)
    status, payload = cc.poll(pid)
    if status == "done":
        png = cc.fetch_image(payload[0])
        with open("/tmp/smoke-bild.png", "wb") as f:
            f.write(png)
        print("fertig in %.1f s, %d Bytes -> /tmp/smoke-bild.png"
              % (time.time() - t0, len(png)))
        sys.exit(0)
    if status == "error":
        sys.exit("Fehler: %s" % payload)

sys.exit("Zeitüberschreitung nach 300 s")
