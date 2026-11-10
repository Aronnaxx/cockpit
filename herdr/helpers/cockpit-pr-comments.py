#!/usr/bin/env python3
"""
cockpit-pr-comments.py <owner/name> <number>
A pull request's conversation as GitHub shows it, oldest first: comments, reviews with their body and state, and review
threads (the file and line, the diff around it, every reply, whether it is resolved or outdated), through the `gh` CLI.
Prints JSON {items: [{kind: comment|review|thread, author, at, body, ...}]}. Nothing is written to GitHub.
"""

import json
import subprocess
import sys
from datetime import datetime

QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    comments(first: 100) { nodes { author { login } body createdAt url } }
    reviews(first: 100) { nodes { author { login } state body submittedAt url } }
    reviewThreads(first: 100) { nodes { isResolved isOutdated path line originalLine diffSide
      comments(first: 50) { nodes { author { login } body createdAt url diffHunk } } } }
  } }
}
"""


def ms(s):
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000) if s else 0


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    owner, name = sys.argv[1].split("/")
    r = subprocess.run(["gh", "api", "graphql", "-f", f"query={QUERY}", "-F", f"owner={owner}", "-F", f"name={name}", "-F", f"number={sys.argv[2]}"], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print(json.dumps({"error": (r.stderr.strip().splitlines() or ["gh failed"])[-1][:200], "items": []}))
        return 0
    pr = json.loads(r.stdout)["data"]["repository"]["pullRequest"]
    items = []
    for c in pr["comments"]["nodes"]:
        items.append({"kind": "comment", "author": (c["author"] or {}).get("login", "ghost"), "at": ms(c["createdAt"]), "body": c["body"], "url": c["url"]})
    for v in pr["reviews"]["nodes"]:
        # A review with no body and only line comments is shown through its threads.
        if v["body"] or v["state"] in ("APPROVED", "CHANGES_REQUESTED"):
            items.append({"kind": "review", "author": (v["author"] or {}).get("login", "ghost"), "at": ms(v["submittedAt"]), "state": v["state"].lower(), "body": v["body"], "url": v["url"]})
    for t in pr["reviewThreads"]["nodes"]:
        cs = t["comments"]["nodes"]
        if not cs:
            continue
        items.append({
            "kind": "thread", "path": t["path"], "line": t["line"] or t["originalLine"], "resolved": t["isResolved"], "outdated": t["isOutdated"], "at": ms(cs[0]["createdAt"]),
            "hunk": (cs[0].get("diffHunk") or "")[-900:], "author": (cs[0]["author"] or {}).get("login", "ghost"), "url": cs[0]["url"],
            "comments": [{"author": (c["author"] or {}).get("login", "ghost"), "at": ms(c["createdAt"]), "body": c["body"]} for c in cs],
        })
    items.sort(key=lambda x: x["at"])
    print(json.dumps({"items": items}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
