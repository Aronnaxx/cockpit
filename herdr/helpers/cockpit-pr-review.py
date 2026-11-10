#!/usr/bin/env python3
"""
cockpit-pr-review.py <owner/name> <number> <draft.json> [--dry-run]
Posts a review draft to GitHub, once the person has read the preview and confirmed: one review with its summary, verdict
(COMMENT, APPROVE or REQUEST_CHANGES) and line comments, then each reply under its thread. The draft is
{"summary": "", "verdict": "COMMENT", "comments": [{"path": "", "line": 1, "body": "", "reply_to": null}]}; a comment with
`reply_to` (a review comment's id) is a reply, any other is a line comment. --pending sends it as a pending review only you see (no replies); --dry-run prints what would be sent and sends
nothing. On success the draft file is removed. Prints JSON {posted, replies} or {error}.
"""

import json
import os
import subprocess
import sys


def gh(*args, data=None):
    return subprocess.run(["gh", *args], input=data, capture_output=True, text=True, timeout=120)


def one(c):
    """A line comment, over a range of lines when it has a start_line."""
    out = {"path": c["path"], "line": int(c["line"]), "side": "RIGHT", "body": c["body"]}
    if c.get("start_line") and int(c["start_line"]) < int(c["line"]):
        out.update(start_line=int(c["start_line"]), start_side="RIGHT")
    return out


def main():
    if len(sys.argv) < 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    slug, number, path = sys.argv[1], sys.argv[2], os.path.expanduser(sys.argv[3])
    dry = "--dry-run" in sys.argv
    pending = "--pending" in sys.argv
    d = json.load(open(path))
    verdict = d.get("verdict") if d.get("verdict") in ("COMMENT", "APPROVE", "REQUEST_CHANGES") else "COMMENT"
    items = [c for c in d.get("comments", []) if str(c.get("body", "")).strip()]
    replies = [c for c in items if c.get("reply_to")]
    lines = [c for c in items if not c.get("reply_to") and c.get("path") and c.get("line")]
    summary = str(d.get("summary", "")).strip()
    if verdict == "REQUEST_CHANGES" and not summary and not lines:
        print(json.dumps({"error": "Requesting changes needs a summary or a comment"}))
        return 0
    head = gh("api", f"repos/{slug}/pulls/{number}", "--jq", ".head.sha").stdout.strip()
    payload = {"commit_id": head, "event": verdict, "body": summary,
               "comments": [one(c) for c in lines]}
    if pending:
        # A pending review: only you see it (GitHub's own draft; VS Code's pull request extension lists it as pending) until you submit it.
        del payload["event"]
        me = gh("api", "user", "--jq", ".login").stdout.strip()
        have = gh("api", f"repos/{slug}/pulls/{number}/reviews", "--paginate", "--jq", f'.[] | select(.state=="PENDING" and .user.login=="{me}") | .id').stdout.split()
        if have:
            print(json.dumps({"error": "A pending review already exists on GitHub (VS Code's, perhaps): submit or discard it there first"}))
            return 0
        if replies:
            print(json.dumps({"error": "Replies to threads cannot be kept pending; post or remove them first"}))
            return 0
    if dry:
        print(json.dumps({"dry_run": True, "review": payload, "replies": [{"to": c["reply_to"], "body": c["body"]} for c in replies]}))
        return 0
    if pending or summary or lines or verdict != "COMMENT":
        r = gh("api", f"repos/{slug}/pulls/{number}/reviews", "--method", "POST", "--input", "-", data=json.dumps(payload))
        if r.returncode != 0:
            print(json.dumps({"error": (r.stderr.strip().splitlines() or ["gh failed"])[-1][:240]}))
            return 0
    sent = 0
    for c in replies:
        r = gh("api", f"repos/{slug}/pulls/{number}/comments/{c['reply_to']}/replies", "--method", "POST", "-f", f"body={c['body']}")
        if r.returncode != 0:
            print(json.dumps({"error": f"reply {sent + 1} failed: " + (r.stderr.strip().splitlines() or ["gh failed"])[-1][:200], "posted": True, "replies": sent}))
            return 0
        sent += 1
    if pending:
        print(json.dumps({"pending": len(lines)}))
        return 0
    os.remove(path)
    print(json.dumps({"posted": len(lines), "replies": sent}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
