#!/usr/bin/env python3
"""
cockpit-pr-pending.py <owner/name> <number> <draft.json> status|push|pull|off [--force]
Keeps a review draft in sync with your pending review on GitHub (only you see it; VS Code's pull request view lists and edits
it), both ways, never publishing anything:

status: your pending review on GitHub as it is now ({exists, review_id, summary, comments, changed}), where `changed` means it
        was edited on GitHub's side (VS Code, the PR page) since the cockpit last sent it.
push:   the draft's summary and line comments become the pending review (it is replaced: GitHub has no way to edit a pending
        review's comments in place). Refused with {conflict: true, remote} when GitHub's side changed since the last sync,
        unless --force. Replies to threads cannot be pending and stay in the draft.
pull:   GitHub's pending review becomes the draft's summary and line comments (replies, and each comment's reason, are kept).
off:    stops keeping it in sync (the pending review on GitHub stays as it is).

What was last sent is kept beside the draft (<draft>.pending.json: {sync, review_id, sent, at}). Prints JSON.
"""

import hashlib
import json
import os
import subprocess
import sys
import time


def gh(*args, data=None):
    return subprocess.run(["gh", *args], input=data, capture_output=True, text=True, timeout=120)


def ok(r):
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip().splitlines() or ["gh failed"])[-1][:240])
    return r.stdout


def norm(summary, comments):
    """What a review says, in one comparable shape: the summary and its line comments, sorted."""
    rows = sorted((str(c.get("path")), int(c.get("line") or 0), int(c.get("start_line") or 0), str(c.get("body", "")).strip()) for c in comments)
    return {"summary": str(summary or "").strip(), "comments": [{"path": p, "line": l, **({"start_line": s} if s and s < l else {}), "body": b} for p, l, s, b in rows]}


def digest(shape):
    return hashlib.sha256(json.dumps(shape, sort_keys=True).encode()).hexdigest()[:16]


def remote(slug, number):
    """Your pending review on the pull request: (id, its shape), or (None, None). Through GraphQL: the REST API gives a pending
    comment no line number."""
    owner, name = slug.split("/", 1)
    me = ok(gh("api", "user", "--jq", ".login")).strip()
    q = """query($o:String!,$n:String!,$p:Int!,$me:String!){repository(owner:$o,name:$n){pullRequest(number:$p){reviews(states:PENDING,author:$me,first:5){nodes{databaseId body comments(first:100){nodes{path line startLine originalLine originalStartLine body}}}}}}}"""
    d = json.loads(ok(gh("api", "graphql", "-f", f"query={q}", "-F", f"o={owner}", "-F", f"n={name}", "-F", f"p={number}", "-F", f"me={me}")))
    nodes = (((d.get("data") or {}).get("repository") or {}).get("pullRequest") or {}).get("reviews", {}).get("nodes") or []
    if not nodes:
        return None, None
    r = nodes[0]
    comments = [{"path": c.get("path"), "line": c.get("line") or c.get("originalLine"), "start_line": c.get("startLine") or c.get("originalStartLine"), "body": c.get("body", "")} for c in (r.get("comments") or {}).get("nodes") or []]
    return str(r.get("databaseId")), norm(r.get("body"), comments)


def local(d):
    lines = [c for c in d.get("comments", []) if not c.get("reply_to") and c.get("path") and c.get("line") and str(c.get("body", "")).strip()]
    return norm(d.get("summary"), lines), len([c for c in d.get("comments", []) if c.get("reply_to") and str(c.get("body", "")).strip()])


def main():
    if len(sys.argv) < 5:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    slug, number, path, op = sys.argv[1], sys.argv[2], os.path.expanduser(sys.argv[3]), sys.argv[4]
    force = "--force" in sys.argv
    state_path = path + ".pending.json"
    try:
        state = json.load(open(state_path))
    except Exception:
        state = {}

    def save(**kw):
        state.update(kw, at=int(time.time() * 1000))
        with open(state_path + ".tmp", "w") as f:
            json.dump(state, f)
        os.replace(state_path + ".tmp", state_path)

    try:
        if op == "off":
            save(sync=False)
            print(json.dumps({"sync": False}))
            return 0
        d = json.load(open(path)) if os.path.exists(path) else {"summary": "", "comments": []}
        rid, shape = remote(slug, number)
        # Changed on GitHub's side: unlike what the cockpit last sent, or (never synced) unlike the draft: nothing is replaced
        # without asking which to keep.
        mine0, _ = local(d)
        changed = bool(shape) and (digest(shape) != state["sent"] if state.get("sent") else digest(shape) != digest(mine0))
        if op == "status":
            mine, _ = local(d)
            print(json.dumps({"exists": bool(rid), "review_id": rid, "changed": changed, "same": bool(shape) and digest(shape) == digest(mine), "sync": bool(state.get("sync")), "synced_at": state.get("synced_at"), **(shape or {"summary": "", "comments": []})}))
            return 0
        if op == "pull":
            if not shape:
                print(json.dumps({"error": "There is no pending review of yours on GitHub"}))
                return 0
            # Keep each comment's reason when the same comment comes back; replies stay as they are.
            old = {(c.get("path"), int(c.get("line") or 0)): c for c in d.get("comments", []) if not c.get("reply_to")}
            d["summary"] = shape["summary"]
            d["comments"] = [{**{k: v for k, v in (old.get((c["path"], c["line"])) or {}).items() if k in ("why", "explained")}, **c} for c in shape["comments"]] + [c for c in d.get("comments", []) if c.get("reply_to")]
            with open(path + ".tmp", "w") as f:
                json.dump(d, f, indent=2)
            os.replace(path + ".tmp", path)
            save(sync=True, review_id=rid, sent=digest(shape), synced_at=int(time.time() * 1000))
            print(json.dumps({"pulled": len(shape["comments"])}))
            return 0
        if op != "push":
            print(json.dumps({"error": f"unknown {op}"}))
            return 2
        if changed and not force:
            print(json.dumps({"conflict": True, "review_id": rid, **shape}))
            return 0
        mine, replies = local(d)
        if shape and digest(shape) == digest(mine):
            save(sync=True, review_id=rid, sent=digest(shape), synced_at=int(time.time() * 1000))
            print(json.dumps({"synced": len(mine["comments"]), "unchanged": True, "replies_kept": replies}))
            return 0
        if rid:
            ok(gh("api", f"repos/{slug}/pulls/{number}/reviews/{rid}", "--method", "DELETE"))
        if not mine["comments"] and not mine["summary"]:
            save(sync=True, review_id=None, sent=None, synced_at=int(time.time() * 1000))
            print(json.dumps({"synced": 0, "removed": bool(rid)}))
            return 0
        head = ok(gh("api", f"repos/{slug}/pulls/{number}", "--jq", ".head.sha")).strip()
        payload = {"commit_id": head, "body": mine["summary"], "comments": [{"path": c["path"], "line": c["line"], "side": "RIGHT", "body": c["body"], **({"start_line": c["start_line"], "start_side": "RIGHT"} if c.get("start_line") else {})} for c in mine["comments"]]}
        made = json.loads(ok(gh("api", f"repos/{slug}/pulls/{number}/reviews", "--method", "POST", "--input", "-", data=json.dumps(payload))))
        # What GitHub kept, as it reads back: the next status compares against this.
        rid2, back = remote(slug, number)
        save(sync=True, review_id=rid2 or made.get("id"), sent=digest(back) if back else digest(mine), synced_at=int(time.time() * 1000))
        print(json.dumps({"synced": len(mine["comments"]), "review_id": rid2 or made.get("id"), "replies_kept": replies}))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)[:300]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
