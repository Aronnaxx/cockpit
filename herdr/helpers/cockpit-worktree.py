#!/usr/bin/env python3
"""
cockpit-worktree.py <owner/name> <number> <repo checkout> [--remove]
cockpit-worktree.py --list [repo checkout ...] | --remove-path <worktree> [--force]   (every worktree of those repositories and under ~/worktrees, or remove one; a dirty one only with --force)
A git worktree of a pull request's head, to read and run its code beside your own checkout: fetches `pull/<number>/head`
into the local branch `cockpit-pr-<number>` and adds the worktree at ~/worktrees/<name>-pr<number> (the one there is reused).
--remove deletes the worktree and the branch. Prints JSON {path} or {error}. Your own branch and checkout are not touched.
"""

import json
import os
import subprocess
import sys


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=300)


def listing(roots):
    """Every git worktree of the repositories at `roots` (plus any under ~/worktrees): {path, name, branch, head, dirty, main, repo, pr, at}."""
    import re
    seen, out, commons = set(), [], set()
    wt = os.path.expanduser("~/worktrees")
    candidates = [os.path.expanduser(r) for r in roots] + [os.path.join(wt, n) for n in (sorted(os.listdir(wt)) if os.path.isdir(wt) else [])]
    for root in candidates:
        if not os.path.exists(os.path.join(root, ".git")):
            continue
        common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
        if not common or common in commons:
            continue
        commons.add(common)
        repo = os.path.dirname(common) if common.endswith(".git") else common
        porcelain = git(repo, "worktree", "list", "--porcelain").stdout
        for block in porcelain.strip().split("\n\n"):
            fields = dict((l.split(" ", 1) + [""])[:2] for l in block.splitlines() if l)
            path = fields.get("worktree")
            if not path or path in seen or not os.path.isdir(path) or "bare" in block:
                continue
            seen.add(path)
            branch = fields.get("branch", "").replace("refs/heads/", "") or "(detached)"
            at = git(path, "log", "-1", "--format=%ct").stdout.strip()
            m = re.search(r"-pr(\d+)$", os.path.basename(path)) or re.match(r"cockpit-pr-(\d+)$", branch)
            out.append({
                "path": path, "name": os.path.basename(path), "branch": branch, "head": fields.get("HEAD", "")[:9],
                "dirty": len([l for l in git(path, "status", "--porcelain").stdout.splitlines() if l.strip()]),
                "main": path == repo, "repo": repo, "repo_name": os.path.basename(repo), "pr": int(m.group(1)) if m else None,
                "at": int(at) * 1000 if at.isdigit() else 0,
            })
    return out


def main():
    if sys.argv[1:2] == ["--list"]:
        print(json.dumps({"worktrees": listing(sys.argv[2:])}))
        return 0
    if sys.argv[1:2] == ["--remove-path"] and len(sys.argv) > 2:
        path = os.path.expanduser(sys.argv[2])
        if not os.path.exists(os.path.join(path, ".git")) or os.path.isdir(os.path.join(path, ".git")):
            print(json.dumps({"error": "That is a repository's own checkout, not a worktree"}))
            return 0
        if git(path, "status", "--porcelain").stdout.strip() and "--force" not in sys.argv:
            print(json.dumps({"error": "It has uncommitted changes"}))
            return 0
        common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
        repo = os.path.dirname(common)
        branch = git(path, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        r = git(repo, "worktree", "remove", "--force", path)
        if branch.startswith("cockpit-pr-"):
            git(repo, "branch", "-D", branch)
        print(json.dumps({"removed": path} if r.returncode == 0 else {"error": (r.stderr.strip().splitlines() or ["failed"])[-1][:200]}))
        return 0
    if len(sys.argv) < 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    slug, number, repo = sys.argv[1], sys.argv[2], os.path.expanduser(sys.argv[3])
    name = slug.split("/")[1]
    branch = f"cockpit-pr-{number}"
    path = os.path.expanduser(f"~/worktrees/{name}-pr{number}")
    if not os.path.isdir(os.path.join(repo, ".git")) and not os.path.isfile(os.path.join(repo, ".git")):
        print(json.dumps({"error": f"{repo} is not a git checkout"}))
        return 0
    if "--remove" in sys.argv:
        git(repo, "worktree", "remove", "--force", path)
        git(repo, "branch", "-D", branch)
        print(json.dumps({"removed": path}))
        return 0
    if os.path.isdir(path):
        # Reuse it, brought to the pull request's latest head.
        f = git(repo, "fetch", "origin", f"+pull/{number}/head:{branch}")
        if f.returncode == 0:
            git(path, "reset", "--hard", branch)
        print(json.dumps({"path": path, "reused": True}))
        return 0
    f = git(repo, "fetch", "origin", f"+pull/{number}/head:{branch}")
    if f.returncode != 0:
        print(json.dumps({"error": (f.stderr.strip().splitlines() or ["git fetch failed"])[-1][:200]}))
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    w = git(repo, "worktree", "add", path, branch)
    if w.returncode != 0:
        print(json.dumps({"error": (w.stderr.strip().splitlines() or ["git worktree add failed"])[-1][:200]}))
        return 0
    print(json.dumps({"path": path}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
