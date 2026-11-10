#!/usr/bin/env python3
"""
cockpit-explain.py pr <owner/name> <number> <model>
cockpit-explain.py why <owner/name> <number> <comment index> <model>
Explanations written by a model of the LiteLLM gateway (cockpit_gateway.py); nothing is written to GitHub.

pr: what the pull request does and how it differs from its base, for a reader who did not write it: a headline, a summary,
before/after by aspect, a diagram of the flow it changes (plain text art), the areas it touches (with their files) and what to
watch. Kept in ~/.cache/cockpit/explain/<owner>__<name>__<number>.json with the head it was written for, and printed. The
lines changed per area are counted here from the diff, never by the model.

why: why a comment of the review draft (~/.cache/cockpit/review-drafts/...) was made: from the code it is on, the PR's diff of
that file, and what the agent that wrote the draft said and did while reviewing (its session transcript, found by the draft's
file name: Claude Code and OpenCode sessions on this machine). Prints {text, sources}.
"""

import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cockpit_gateway  # noqa: E402

CACHE = os.path.expanduser("~/.cache/cockpit/explain")
DRAFTS = os.path.expanduser("~/.cache/cockpit/review-drafts")


def gh(*args, timeout=90):
    r = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip().splitlines() or ["gh failed"])[-1][:200])
    return r.stdout


def file_stats(diff):
    """Lines added and removed per file, from the unified diff."""
    out, cur = {}, None
    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*?) b/(.*)$", line)
            cur = m.group(2) if m else None
            if cur:
                out[cur] = [0, 0]
        elif cur and line.startswith("+") and not line.startswith("+++"):
            out[cur][0] += 1
        elif cur and line.startswith("-") and not line.startswith("---"):
            out[cur][1] += 1
    return out


PR_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["headline", "summary", "before_after", "diagram", "areas", "watch"],
    "properties": {
        "headline": {"type": "string"},
        "summary": {"type": "string"},
        "before_after": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["aspect", "before", "after"], "properties": {"aspect": {"type": "string"}, "before": {"type": "string"}, "after": {"type": "string"}}}},
        "diagram": {"type": "object", "additionalProperties": False, "required": ["title", "direction", "nodes", "edges", "caption"], "properties": {
            "title": {"type": "string"}, "caption": {"type": "string"}, "direction": {"enum": ["down", "right"]},
            "nodes": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["id", "label", "kind", "changed"], "properties": {"id": {"type": "string"}, "label": {"type": "string"}, "kind": {"enum": ["box", "round", "decision"]}, "changed": {"type": "boolean"}}}},
            "edges": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["from", "to", "label"], "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "label": {"type": "string"}}}}}},
        "areas": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["name", "what", "files"], "properties": {"name": {"type": "string"}, "what": {"type": "string"}, "files": {"type": "array", "items": {"type": "string"}}}}},
        "watch": {"type": "array", "items": {"type": "string"}},
    },
}

PR_SYSTEM = """You explain a pull request to an engineer who did not write it, so they understand what it does and how the code differs from its base branch before reading the diff. Describe, never judge or instruct.

Answer with one JSON object:
- headline: one sentence, what the change does for its users or callers.
- summary: markdown, one to three short paragraphs: the problem, the approach, what is different afterwards.
- before_after: three to six rows, each an aspect (a behaviour, an API, a data flow, a limit) with how it was on the base branch and how it is with the change. Short phrases.
- diagram: the main flow the change touches, as a flowchart: 5 to 16 nodes (a short label each, a second line after "\n" for detail; kind "decision" for a branch, "round" for an entry or an end), edges between them (label only where it says something, else ""), changed true on the steps this change adds or alters, direction "down" (or "right" for a pipeline); a title and a one-sentence caption.
- areas: two to seven areas of the code it touches, each with a short name, one sentence on what changes there, and its files (exact paths from the diff; every file belongs to one area).
- watch: up to four things a reader of this change signs up for (a new dependency, a behaviour that changed for existing callers, a limit, something untested), one sentence each; empty if none."""


def explain_pr(slug, number, model):
    meta = json.loads(gh("pr", "view", str(number), "-R", slug, "--json", "title,body,headRefOid,baseRefName,headRefName,author"))
    diff = gh("pr", "diff", str(number), "-R", slug, timeout=120)
    stats = file_stats(diff)
    body = (meta.get("body") or "")[:6000]
    prompt = f"Pull request {slug}#{number}: {meta['title']}\nBy {meta.get('author', {}).get('login')}, {meta['headRefName']} into {meta['baseRefName']}.\n\nDescription:\n{body or '(none)'}\n\nFiles (+added -removed):\n" + "\n".join(f"{p} +{a} -{r}" for p, (a, r) in stats.items()) + f"\n\nThe diff:\n{diff[:160000]}" + ("\n(the diff is cut here)" if len(diff) > 160000 else "")
    text, _ = cockpit_gateway.ask(model, [{"role": "system", "content": PR_SYSTEM + "\n\nThe JSON schema:\n" + json.dumps(PR_SCHEMA)}, {"role": "user", "content": prompt}], max_tokens=16000, schema=PR_SCHEMA)
    d = cockpit_gateway.as_json(text)
    # The lines per area, counted from the diff; files the model left out go under "Other".
    seen = set()
    for a in d.get("areas") or []:
        a["files"] = [f for f in a.get("files") or [] if f in stats]
        seen.update(a["files"])
        a["added"] = sum(stats[f][0] for f in a["files"])
        a["removed"] = sum(stats[f][1] for f in a["files"])
    rest = [f for f in stats if f not in seen]
    if rest:
        d.setdefault("areas", []).append({"name": "Other", "what": "Files no area above names.", "files": rest, "added": sum(stats[f][0] for f in rest), "removed": sum(stats[f][1] for f in rest)})
    d.update(model=model, head=meta["headRefOid"], at=int(time.time() * 1000), files=len(stats), added=sum(a for a, _ in stats.values()), removed=sum(r for _, r in stats.values()))
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{slug.replace('/', '__')}__{number}.json")
    with open(path + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(path + ".tmp", path)
    return d


def transcripts(name, about):
    """What the agents that wrote the draft said and did about `about` (a file's name): from every Claude Code and OpenCode
    session on this machine that names the draft file. Newest first, a few thousand characters each."""
    out = []
    files = subprocess.run(["grep", "-l", "-r", "--include=*.jsonl", name, os.path.expanduser("~/.claude/projects")], capture_output=True, text=True, timeout=30).stdout.split()
    def started_on_it(f):
        # A session that was asked to write the draft names it in its first prompt (not one that only talks about it later).
        with open(f, encoding="utf-8", errors="ignore") as h:
            for i, line in enumerate(h):
                if '"type":"user"' in line.replace(" ", ""):
                    return name in line
                if i > 40:
                    return False
        return False

    for f in [f for f in sorted(files, key=os.path.getmtime, reverse=True) if started_on_it(f)][:2]:
        bits = []
        for line in open(f, encoding="utf-8", errors="ignore"):
            if about not in line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            content = (e.get("message") or {}).get("content")
            for c in content if isinstance(content, list) else [{"type": "text", "text": content}]:
                if not isinstance(c, dict):
                    continue
                t = c.get("text") or (json.dumps(c.get("input"))[:600] if c.get("type") == "tool_use" else "") or (str(c.get("content"))[:600] if c.get("type") == "tool_result" else "")
                if t and about in t:
                    bits.append(f"[{e.get('type')}{' ' + c.get('name') if c.get('name') else ''}] {t[:900]}")
        if bits:
            out.append(("Claude Code session " + os.path.basename(f)[:8], bits[-14:]))
    db = os.path.expanduser("~/.local/share/opencode/opencode.db")
    if os.path.exists(db):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            sids = [r[0] for r in con.execute("select distinct session_id from session_message where data like ? order by rowid desc limit 3", (f"%{name}%",))]
            for sid in sids[:2]:
                bits = []
                for kind, data in con.execute("select type, data from session_message where session_id = ? and data like ? order by seq", (sid, f"%{about}%")):
                    bits.append(f"[{kind}] {data[:900]}")
                if bits:
                    out.append((f"OpenCode session {sid[:12]}", bits[-14:]))
        except Exception:
            pass
    return out


def explain_why(slug, number, index, model):
    name = f"{slug.replace('/', '__')}__{number}.json"
    d = json.load(open(os.path.join(DRAFTS, name)))
    c = (d.get("comments") or [])[int(index)]
    if c.get("reply_to"):
        about, where = "", f"a reply to: {c.get('quote')}"
    else:
        about, where = os.path.basename(c.get("path") or ""), f"{c.get('path')} line {c.get('start_line') or c.get('line')}{'-' + str(c['line']) if c.get('start_line') else ''}"
    code = ""
    if c.get("path"):
        r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "cockpit-pr-file.py"), slug, str(number), c["path"]], capture_output=True, text=True, timeout=90)
        lines = (json.loads(r.stdout or "{}").get("files") or {}).get(c["path"]) or []
        lo, hi = max(1, int(c.get("start_line") or c.get("line") or 1) - 25), int(c.get("line") or 1) + 25
        code = "\n".join(f"{i:5} {lines[i - 1]}" for i in range(lo, min(hi, len(lines)) + 1))
    diff = ""
    if c.get("path"):
        full = gh("pr", "diff", str(number), "-R", slug, timeout=120)
        m = re.search(r"(?ms)^diff --git a/" + re.escape(c["path"]) + r" .*?(?=^diff --git |\Z)", full)
        diff = m.group(0)[:12000] if m else ""
    sessions = transcripts(name, about or str(c.get("quote") or "")[:40]) if (about or c.get("quote")) else []
    notes = "\n\n".join(f"{label}:\n" + "\n".join(bits) for label, bits in sessions)[:24000]
    prompt = (
        f"A review comment on pull request {slug}#{number}, on {where}:\n\n{c.get('body')}\n\n"
        + (f"What the reviewing agent recorded as its reason:\n{c['why']}\n\n" if c.get("why") else "")
        + (f"The code there, at the PR's head (line numbers on the left):\n{code}\n\n" if code else "")
        + (f"The PR's diff of that file:\n{diff}\n\n" if diff else "")
        + (f"What the reviewing agent said and did about this file while reviewing (excerpts of its session):\n{notes}\n\n" if notes else "(No session of the reviewing agent was found on this machine.)\n\n")
    )
    system = ("You explain to an engineer WHY a code review comment written by an AI agent was made, so they can decide whether to keep it. "
              "In markdown, short: **What it is about** (the code and behaviour, quoting a line or two), **Why the agent raised it** (what it saw or ran, from its session when there is one; say plainly when there is no record and you are inferring), "
              "**Does it hold up** (whether the code supports it, and the strongest reason it might be wrong), **Confidence** (high, medium or low, one line). Under 250 words. Never invent what the agent did.")
    text, _ = cockpit_gateway.ask(model, [{"role": "system", "content": system}, {"role": "user", "content": prompt}], max_tokens=6000)
    return {"text": text, "sources": [label for label, _ in sessions], "model": model}


def main():
    a = sys.argv[1:]
    try:
        if len(a) >= 4 and a[0] == "pr":
            print(json.dumps(explain_pr(a[1], a[2], a[3])))
        elif len(a) >= 5 and a[0] == "why":
            print(json.dumps(explain_why(a[1], a[2], a[3], a[4])))
        else:
            print(__doc__.strip(), file=sys.stderr)
            return 2
    except Exception as e:
        print(json.dumps({"error": str(e)[:400]}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
