#!/usr/bin/env python3
"""
cockpit-pr-file.py <owner/name> <number> <path>...
The files of a pull request as they are at its head, for showing the lines a review comment is about: prints
{"files": {path: [line, ...]}} (a file that cannot be read is left out). Nothing is written to GitHub.
"""

import json
import subprocess
import sys


def gh(*args):
    return subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)


def main():
    if len(sys.argv) < 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    slug, number, paths = sys.argv[1], sys.argv[2], sys.argv[3:]
    head = gh("api", f"repos/{slug}/pulls/{number}", "--jq", ".head.sha").stdout.strip()
    out = {}
    for p in paths:
        r = gh("api", f"repos/{slug}/contents/{p}?ref={head}", "-H", "Accept: application/vnd.github.raw")
        if r.returncode == 0:
            out[p] = r.stdout.splitlines()[:4000]
    print(json.dumps({"files": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
