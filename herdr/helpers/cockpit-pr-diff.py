#!/usr/bin/env python3
"""
cockpit-pr-diff.py <owner/name> <number>
The files a pull request changes, as GitHub's "Files changed" has them: {"files": [{path, status, additions, deletions, patch}]}
(a binary or very large file has no patch). Read only.
"""

import json
import subprocess
import sys


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    r = subprocess.run(["gh", "api", f"repos/{sys.argv[1]}/pulls/{sys.argv[2]}/files", "--paginate", "--jq", ".[] | {path: .filename, status, additions, deletions, patch}"], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        print(json.dumps({"error": (r.stderr.strip().splitlines() or ["gh failed"])[-1][:200], "files": []}))
        return 0
    files = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
    print(json.dumps({"files": files}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
