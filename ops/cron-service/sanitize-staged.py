#!/usr/bin/env python3
"""Fail-closed fixes to the staged HELA-12871 host copies.

Input files have already had their legacy credential literal stripped and the
reviewed HELA-12871 patches applied.  This script never prints file contents.
"""

from pathlib import Path
import re
import sys


def change(text, pattern, replacement, label, *, flags=0):
    text, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: source anchor changed")
    return text


def main(stage):
    watchdog = stage / "agent-watchdog.py"
    text = watchdog.read_text()
    text = change(text, r"^DSN = os\.environ\['WATCHDOG_PG'\]$", "DSN = 'pc_watchdog'",
                  "watchdog DB service", flags=re.M)
    text = change(
        text,
        r"^    return subprocess\.run\(\['/usr/bin/psql', DSN, '-tAc', sql\], capture_output=True, text=True\)\.stdout\.strip\(\)$",
        "    result = subprocess.run(['/usr/bin/psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', DSN, "
        "'-tAc', sql], capture_output=True, text=True, timeout=30)\n"
        "    if result.returncode != 0:\n"
        "        raise RuntimeError('watchdog DB query failed')\n"
        "    return result.stdout.strip()",
        "watchdog psql", flags=re.M,
    )
    watchdog.write_text(text)

    quota = stage / "quota_rewake.py"
    text = quota.read_text()
    text = change(text, r"^CONN = os\.environ\['QR_PG'\]$", "CONN = 'pc_quota'",
                  "quota DB service", flags=re.M)
    text = change(text, r"\['psql', CONN,", "['/usr/bin/psql', '-X', '-d', CONN,",
                  "quota psql")
    text = change(text, r"^OPS_ENV = .*\n", "", "quota ops env", flags=re.M)
    text = change(text, r"^MAX_RESTORES = .*\n", "", "quota direct limit", flags=re.M)
    text = change(text, r"def read_env_file\(path, key\):\n.*?(?=def agent_token\(\):)",
                  "", "quota ops env reader", flags=re.S)
    text = change(text, r"def board_token\(\):\n.*?(?=def api\()",
                  "", "quota board source", flags=re.S)
    text = change(text, r"def restore_direct\(card, reason, token\):\n.*?(?=NUDGE_TITLE_PREFIX)",
                  "", "quota direct restore", flags=re.S)
    text = change(text, r"^    mode = 'direct' if board_token\(\) else \('nudge' if args\.nudge else 'direct'\)$",
                  "    mode = 'nudge'", "quota mode", flags=re.M)
    text = change(text, r"^    board = board_token\(\)\n    done = 0\n    if board:\n.*?(?=    if not args\.nudge:)",
                  "    done = 0\n", "quota board execution", flags=re.S | re.M)
    text = change(text, r"^            log\('quota-rewake: нет board-токена и --nudge не задан -> только отчёт \(%d карт ждут\)' % len\(actions\)\)$",
                  "            log('quota-rewake: --nudge не задан -> только отчёт (%d карт ждут)' % len(actions))",
                  "quota report", flags=re.M)
    text = change(text, r"^        if not c\['ownerAgentId'\]:\n.*?(?=        # HELA-12213:)",
                  "        if not c['ownerAgentId']:\n"
                  "            # No cross-assignee or unassigned direct restore in this service.\n"
                  "            continue\n",
                  "quota unassigned restore", flags=re.S | re.M)
    if any(word in text for word in ("PAPERCLIP_OPS_TOKEN", "OPS_ENV", "board_token", "restore_direct", "restore_unassigned")):
        raise SystemExit("quota: broad credential or direct restore remains")
    quota.write_text(text)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: sanitize-staged.py STAGE_DIR")
    main(Path(sys.argv[1]))
