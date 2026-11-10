#!/usr/bin/env python3
"""
cockpit-prs.py [--force]
Your open pull requests and the ones you review, with what GitHub's own page shows and cockpit needs: whose move it is, each
reviewer's state (a review asked again after they reviewed is "re-requested"), approvals out of what the repo needs, the
last activity of each reviewer and their comments, CI state with the failed checks, and how far behind the base it is.
Asked of GitHub through the `gh` CLI (GraphQL), kept in ~/.cache/cockpit/prs.json for a minute. Prints JSON.
The approvals a repo needs are not readable without admin rights: `prs.required` in ~/.config/cockpit/config.json,
{"owner/name": 2}, else 2.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime

CACHE = os.path.expanduser("~/.cache/cockpit/prs.json")
CONFIG = os.path.expanduser("~/.config/cockpit/config.json")
NOW = time.time()

QUERY = """
query($mine: String!, $assigned: String!, $reviewed: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 30) { nodes { ...PR } }
  assigned: search(query: $assigned, type: ISSUE, first: 40) { nodes { ...PR } }
  reviewed: search(query: $reviewed, type: ISSUE, first: 40) { nodes { ...PR } }
}
fragment PR on PullRequest {
  number title url isDraft headRefName baseRefName headRefOid updatedAt createdAt mergeStateStatus mergeable reviewDecision
  repository { nameWithOwner }
  author { login }
  reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
  latestOpinionatedReviews(first: 30) { nodes { state submittedAt author { login } commit { oid } } }
  reviews(first: 80) { nodes { state submittedAt body author { login } commit { oid } } }
  comments(first: 80) { nodes { createdAt author { login } } }
  reviewThreads(first: 80) { nodes { isResolved comments(first: 40) { nodes { createdAt author { login } } } } }
  commits(last: 1) { nodes { commit { committedDate oid statusCheckRollup { state contexts(first: 40) { nodes {
    __typename
    ... on CheckRun { name conclusion status detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }
  timelineItems(last: 100, itemTypes: [REVIEW_REQUESTED_EVENT, PULL_REQUEST_COMMIT]) { nodes {
    __typename
    ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
    ... on PullRequestCommit { commit { committedDate } }
  } }
}
"""


def ms(s):
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000) if s else 0


def gh(args, stdin=None):
    r = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip().splitlines() or ["gh failed"])[-1][:200])
    return json.loads(r.stdout or "null")


def behind_by(repo, base, head):
    try:
        return gh(["api", f"repos/{repo}/compare/{base}...{head}", "--jq", "{behind: .behind_by, ahead: .ahead_by}"]).get("behind")
    except Exception:
        return None


def build(p, me, required_cfg, role):
    repo = p["repository"]["nameWithOwner"]
    requested = {}
    for n in (p["reviewRequests"]["nodes"] or []):
        r = n.get("requestedReviewer") or {}
        name = r.get("login") or r.get("name")
        if name:
            requested[name] = r.get("__typename")
    asked_at = {}
    commits_at = []
    for t in p["timelineItems"]["nodes"] or []:
        if t["__typename"] == "ReviewRequestedEvent":
            login = (t.get("requestedReviewer") or {}).get("login")
            if login:
                asked_at[login] = max(asked_at.get(login, 0), ms(t["createdAt"]))
        elif t["__typename"] == "PullRequestCommit":
            commits_at.append(ms(t["commit"]["committedDate"]))
    head = (p["commits"]["nodes"] or [{}])[0].get("commit") or {}
    pushed_at = max(commits_at + [ms(head.get("committedDate"))]) if (commits_at or head) else 0

    people = {}

    def person(login):
        return people.setdefault(login, {"login": login, "reviews": [], "comments": 0, "last": 0, "state": None, "last_review": 0, "last_commit": None})

    for r in p["reviews"]["nodes"] or []:
        login = (r.get("author") or {}).get("login")
        if not login or login == p["author"]["login"]:
            continue
        x = person(login)
        at = ms(r["submittedAt"])
        x["reviews"].append({"state": r["state"], "at": at})
        x["last"] = max(x["last"], at)
        x["last_review"] = max(x["last_review"], at)
        x["last_commit"] = (r.get("commit") or {}).get("oid") or x["last_commit"]
        if r.get("body"):
            x["comments"] += 1
    unresolved = 0
    for th in p["reviewThreads"]["nodes"] or []:
        if not th["isResolved"]:
            unresolved += 1
        for c in th["comments"]["nodes"] or []:
            login = (c.get("author") or {}).get("login")
            if login and login != p["author"]["login"]:
                x = person(login)
                x["comments"] += 1
                x["last"] = max(x["last"], ms(c["createdAt"]))
    for c in p["comments"]["nodes"] or []:
        login = (c.get("author") or {}).get("login")
        if login and login != p["author"]["login"]:
            x = person(login)
            x["comments"] += 1
            x["last"] = max(x["last"], ms(c["createdAt"]))
    for login in requested:
        person(login)
    opinion = {(n.get("author") or {}).get("login"): n for n in p["latestOpinionatedReviews"]["nodes"] or []}
    for login, x in people.items():
        o = opinion.get(login)
        had_review = bool(x["reviews"])
        if login in requested:
            x["state"] = "re-requested" if had_review else "requested"
            x["asked_at"] = asked_at.get(login)
        elif o:
            x["state"] = o["state"].lower()
        elif had_review:
            x["state"] = "commented"
        x["requested"] = login in requested
        x["re_requested"] = login in requested and had_review
        x["last"] = x["last"] or asked_at.get(login, 0)
        x["new_commits"] = bool(x["last_review"] and pushed_at > x["last_review"])
        del x["reviews"]

    approvals = sum(1 for n in opinion.values() if n["state"] == "APPROVED")
    required = int((required_cfg or {}).get(repo, 2))
    # CI, with the checks that failed.
    rollup = head.get("statusCheckRollup") or {}
    failed, pending = [], 0
    for c in (rollup.get("contexts") or {}).get("nodes") or []:
        if c["__typename"] == "CheckRun":
            if c.get("status") != "COMPLETED":
                pending += 1
            elif c.get("conclusion") in ("FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"):
                failed.append({"name": c["name"], "url": c.get("detailsUrl")})
        else:
            if c.get("state") in ("FAILURE", "ERROR"):
                failed.append({"name": c["context"], "url": c.get("targetUrl")})
            elif c.get("state") == "PENDING":
                pending += 1
    builds = []
    for c in (rollup.get("contexts") or {}).get("nodes") or []:
        u = c.get("targetUrl") or c.get("detailsUrl") or ""
        if "buildkite.com" in u and "/builds/" in u and u not in builds:
            builds.append(u)
    ci = {"state": (rollup.get("state") or "NONE").lower(), "failed": failed, "pending": pending, "builds": builds}
    last_activity = max([ms(p["updatedAt"]), pushed_at] + [x["last"] for x in people.values()])

    out = {
        "repo": repo, "number": p["number"], "title": p["title"], "url": p["url"], "branch": p["headRefName"], "base": p["baseRefName"],
        "draft": p["isDraft"], "author": p["author"]["login"], "role": role, "decision": p["reviewDecision"], "merge_state": p["mergeStateStatus"],
        "approvals": approvals, "required": required, "reviewers": sorted(people.values(), key=lambda x: -x["last"]), "unresolved": unresolved,
        "ci": ci, "pushed_at": pushed_at, "last_activity": last_activity, "head": p["headRefOid"],
    }
    out["turn"] = turn_of(out, me, requested, people)
    return out


def names(xs):
    return ", ".join(xs[:3]) + (f" +{len(xs) - 3}" if len(xs) > 3 else "")


def turn_of(p, me, requested, people):
    """Whose move it is: {who: you|them|none, why, detail}."""
    if p["role"] == "reviewer":
        mine = people.get(me)
        if me in requested:
            if mine and mine["re_requested"]:
                return {"who": "you", "why": "re-review", "detail": "You were asked to review again" + (" and there are new commits since your review" if mine.get("new_commits") else "")}
            return {"who": "you", "why": "review", "detail": "Waiting for your review"}
        if mine:
            return {"who": "them", "why": "author", "detail": "You reviewed it; the author has the move"}
        return {"who": "none", "why": "", "detail": ""}
    if p["draft"]:
        return {"who": "you", "why": "draft", "detail": "Still a draft"}
    if p["ci"]["failed"]:
        return {"who": "you", "why": "ci", "detail": "CI failed: " + names([f["name"] for f in p["ci"]["failed"]])}
    open_asks = [x["login"] for x in p["reviewers"] if not x["requested"] and x["state"] == "changes_requested"]
    if open_asks:
        return {"who": "you", "why": "changes", "detail": "Changes asked by " + names(open_asks)}
    comment_back = [x["login"] for x in p["reviewers"] if not x["requested"] and x["state"] == "commented" and x["last"] > p["pushed_at"]]
    if comment_back:
        return {"who": "you", "why": "comments", "detail": "New comments from " + names(comment_back)}
    waiting = [x["login"] for x in p["reviewers"] if x["requested"]]
    if waiting:
        again = [x["login"] for x in p["reviewers"] if x["re_requested"]]
        return {"who": "them", "why": "re-requested" if again else "requested", "detail": ("Re-requested: " + names(again)) if again else "Waiting for " + names(waiting)}
    if p["approvals"] >= p["required"] and p["ci"]["state"] in ("success", "none"):
        return {"who": "you", "why": "merge", "detail": "Approved and green: ready to merge"}
    return {"who": "you", "why": "reviewers", "detail": "Nobody is asked to review it"}


def main():
    force = "--force" in sys.argv
    try:
        old = json.load(open(CACHE))
        if not force and NOW - old.get("at", 0) / 1000 < 60:
            print(json.dumps(old))
            return 0
    except Exception:
        old = None
    try:
        cfg = (json.load(open(CONFIG)).get("prs") or {})
    except Exception:
        cfg = {}
    try:
        d = gh(["api", "graphql", "-f", f"query={QUERY}", "-f", "mine=is:pr is:open author:@me archived:false sort:updated-desc", "-f", "assigned=is:pr is:open review-requested:@me archived:false sort:updated-desc", "-f", "reviewed=is:pr is:open reviewed-by:@me -author:@me archived:false sort:updated-desc"])["data"]
    except Exception as e:
        print(json.dumps({**(old or {}), "error": str(e), "stale": True}))
        return 0
    me = d["viewer"]["login"]
    req = cfg.get("required") or {}
    mine = [build(p, me, req, "author") for p in d["mine"]["nodes"] if p]
    seen = set()
    theirs = []
    for p in (d["assigned"]["nodes"] or []) + (d["reviewed"]["nodes"] or []):
        if p and p["url"] not in seen and p["author"]["login"] != me:
            seen.add(p["url"])
            theirs.append(build(p, me, req, "reviewer"))
    for p in mine:
        p["behind"] = behind_by(p["repo"], p["base"], p["head"])
    result = {"at": int(NOW * 1000), "me": me, "mine": mine, "assigned": theirs}
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE + ".tmp", "w") as f:
        json.dump(result, f)
    os.replace(CACHE + ".tmp", CACHE)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
