#!/usr/bin/env python3
"""
cockpit-explain.py pr <owner/name> <number> <model>
cockpit-explain.py why <owner/name> <number> <comment index> <model>
cockpit-explain.py fill <owner/name> <number>
cockpit-explain.py quiz <owner/name> <number> <model> [--missed <file of questions answered wrong>]
Explanations written by a model of the LiteLLM gateway (cockpit_gateway.py); nothing is written to GitHub.

pr: what the pull request does and how it differs from its base, for a reader who did not write it: a headline, a summary,
before/after by aspect, a flowchart of the flow it changes, the areas it touches (with their files) and what to
watch. Kept in ~/.cache/cockpit/explain/<owner>__<name>__<number>.json with the head it was written for, and printed. The
lines changed per area are counted here from the diff, never by the model.

fill: an explanation a reviewing agent wrote itself (the cockpit-pr-review skill): its lines per area, its files and the head
it was written for, counted here from the diff, as `pr` adds them.

quiz: questions that check the person understands the change before they put their name on a review: what it does, how it
behaves, and whether the draft's comments (the agent's) hold up. Multiple choice, each with the answer and why. How hard and
how many: quiz.difficulty ("basics", "standard", "deep") and quiz.count ("fit": by the size of the change and the draft, or a
number) in the cockpit config. --missed: new questions on what the person got wrong last time. Kept in
~/.cache/cockpit/quiz/<owner>__<name>__<number>.json with the head, and printed.

why: why a comment of the review draft (~/.cache/cockpit/review-drafts/...) was made: from the code it is on, the PR's diff of
that file, and what the agent that wrote the draft said and did while reviewing (its session transcript, found by the draft's
file name: Claude Code and OpenCode sessions on this machine). Prints {text, sources}.
"""

import glob
import json
import os
import random
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


def counted(d, stats):
    """The lines added and removed per area, from the diff; files no area names go under "Other"."""
    seen = set()
    for a in d.get("areas") or []:
        # A file is counted once, under the first area that names it.
        a["files"] = [f for f in dict.fromkeys(a.get("files") or []) if f in stats and f not in seen]
        seen.update(a["files"])
        a["added"] = sum(stats[f][0] for f in a["files"])
        a["removed"] = sum(stats[f][1] for f in a["files"])
    rest = [f for f in stats if f not in seen]
    if rest:
        d.setdefault("areas", []).append({"name": "Other", "what": "Files no area above names.", "files": rest, "added": sum(stats[f][0] for f in rest), "removed": sum(stats[f][1] for f in rest)})
    d.update(files=len(stats), added=sum(a for a, _ in stats.values()), removed=sum(r for _, r in stats.values()))
    return d


def save(slug, number, d):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{slug.replace('/', '__')}__{number}.json")
    with open(path + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(path + ".tmp", path)
    return d


def fill(slug, number):
    path = os.path.join(CACHE, f"{slug.replace('/', '__')}__{number}.json")
    d = json.load(open(path))
    if d.get("files") is not None and d.get("head"):
        return d
    head = json.loads(gh("pr", "view", str(number), "-R", slug, "--json", "headRefOid"))["headRefOid"]
    counted(d, file_stats(gh("pr", "diff", str(number), "-R", slug, timeout=120)))
    d.update(head=d.get("head") or head, at=d.get("at") or int(os.path.getmtime(path) * 1000), model=d.get("model") or "the reviewing agent", by_agent=True)
    return save(slug, number, d)


def explain_pr(slug, number, model):
    meta = json.loads(gh("pr", "view", str(number), "-R", slug, "--json", "title,body,headRefOid,baseRefName,headRefName,author"))
    diff = gh("pr", "diff", str(number), "-R", slug, timeout=120)
    stats = file_stats(diff)
    body = (meta.get("body") or "")[:6000]
    prompt = f"Pull request {slug}#{number}: {meta['title']}\nBy {meta.get('author', {}).get('login')}, {meta['headRefName']} into {meta['baseRefName']}.\n\nDescription:\n{body or '(none)'}\n\nFiles (+added -removed):\n" + "\n".join(f"{p} +{a} -{r}" for p, (a, r) in stats.items()) + f"\n\nThe diff:\n{diff[:160000]}" + ("\n(the diff is cut here)" if len(diff) > 160000 else "")
    text, _ = cockpit_gateway.ask(model, [{"role": "system", "content": PR_SYSTEM + "\n\nThe JSON schema:\n" + json.dumps(PR_SCHEMA)}, {"role": "user", "content": prompt}], max_tokens=16000, schema=PR_SCHEMA)
    d = cockpit_gateway.as_json(text)
    counted(d, stats)
    d.update(model=model, head=meta["headRefOid"], at=int(time.time() * 1000))
    return save(slug, number, d)


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

QUIZ_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["questions"],
    "properties": {"questions": {"type": "array", "items": {"type": "object", "additionalProperties": False,
        "required": ["about", "comment", "question", "choices", "answer", "explain"],
        "properties": {
            "about": {"enum": ["behaviour", "design", "risk", "comment"]},
            "comment": {"type": "integer"},
            "question": {"type": "string"},
            "choices": {"type": "array", "items": {"type": "string"}},
            "answer": {"type": "integer"},
            "explain": {"type": "string"}}}}},
}

QUIZ_SYSTEM = """You write a short quiz for an engineer who is about to put their name on a code review of a pull request, much of it drafted by an AI agent. The quiz checks that they understand the change themselves rather than passing on what the agent said. Ask about the code, never trivia (no "how many files", no names to memorise).

Write exactly {count} questions, multiple choice, four choices each, one right:
- about half on the change itself ("behaviour": what happens now in a concrete case, before vs after; "design": why it is built this way or what it trades off; "risk": what could break and for whom). Use concrete inputs and situations from the code.
- the rest on the draft's comments (none if it has none) ("comment", with "comment" set to the comment's index as given): does the comment's claim hold, what in the code makes it so, or what the right fix is. When a comment is wrong or overstated, the right answer says so. Do not leak the answer in the question.
For other questions "comment" is -1. "answer" is the index (0-3) of the right choice; place it at varying positions. Make the wrong choices plausible to someone who only skimmed. "explain": two or three sentences on why the answer is right, pointing at the code (file and line)."""


LEVELS = {
    "basics": "Difficulty: basics. Ask what the change does and how it behaves in the common case, so someone who read the description and skimmed the diff carefully can answer. Wrong choices are clearly wrong on a careful read.",
    "standard": "Difficulty: standard. Ask about concrete behaviour and the reasons behind the design, needing the diff read with care.",
    "deep": "Difficulty: deep. Ask about edge cases, failure modes, concurrency and ordering, interplay between files and what happens to existing callers; questions that need the code itself, not the description. Wrong choices are plausible to someone who read the diff once.",
}


def quiz_shape(stats, comments):
    """How hard and how many, from the config: a fitted count grows with the change's size and the draft's comments."""
    try:
        q = json.load(open(os.path.expanduser("~/.config/cockpit/config.json"))).get("quiz") or {}
    except Exception:
        q = {}
    level = q.get("difficulty") if q.get("difficulty") in LEVELS else "standard"
    count = q.get("count", "fit")
    if isinstance(count, int) or str(count).isdigit():
        n = max(2, min(20, int(count)))
    else:
        changed = sum(a + r for a, r in stats.values())
        n = 3 + (changed > 40) + (changed > 150) + (changed > 400) + (changed > 1000) + (len(stats) > 8) + min(4, (len(comments) + 1) // 2)
        n = max(4, min(14, n))
    return level, n


def quiz(slug, number, model, missed=None):
    meta = json.loads(gh("pr", "view", str(number), "-R", slug, "--json", "title,body,headRefOid"))
    diff = gh("pr", "diff", str(number), "-R", slug, timeout=120)
    name = f"{slug.replace('/', '__')}__{number}.json"
    try:
        draft = json.load(open(os.path.join(DRAFTS, name)))
    except Exception:
        draft = {}
    comments = [(i, c) for i, c in enumerate(draft.get("comments") or []) if c.get("path") and str(c.get("body", "")).strip()]
    level, count = quiz_shape(file_stats(diff), comments)
    listed = "\n\n".join(f"[{i}] {c['path']} line {c.get('start_line') or c.get('line')}{'-' + str(c['line']) if c.get('start_line') else ''}:\n{c['body']}" for i, c in comments)
    prompt = f"Pull request {slug}#{number}: {meta['title']}\n\n{(meta.get('body') or '')[:4000]}\n\nThe draft's comments:\n{listed or '(none: ask only about the change)'}\n\nThe diff:\n{diff[:150000]}"
    if missed:
        prompt += "\n\nLast time the person got these wrong. Ask about the same parts of the code again, in new ways (other cases, other angles), without repeating these questions:\n" + "\n".join(f"- {m}" for m in missed[:10])
    system = QUIZ_SYSTEM.replace("{count}", str(count)) + "\n\n" + LEVELS[level] + "\n\nThe JSON schema:\n" + json.dumps(QUIZ_SCHEMA)
    text, _ = cockpit_gateway.ask(model, [{"role": "system", "content": system}, {"role": "user", "content": prompt}], max_tokens=16000, schema=QUIZ_SCHEMA)
    d = cockpit_gateway.as_json(text)
    by = dict(comments)
    qs = []
    for q in d.get("questions") or []:
        if len(q.get("choices") or []) < 2 or not 0 <= int(q.get("answer", -1)) < len(q["choices"]):
            continue
        # Models put the right answer in the same place: shuffled here, the answer moved with it.
        order = list(range(len(q["choices"])))
        random.shuffle(order)
        q["answer"] = order.index(int(q["answer"]))
        q["choices"] = [q["choices"][j] for j in order]
        c = by.get(int(q.get("comment", -1)))
        if q.get("about") == "comment" and c:
            q["path"], q["line"], q["start_line"] = c["path"], c.get("line"), c.get("start_line")
        qs.append(q)
    out = {"questions": qs, "model": model, "head": meta["headRefOid"], "at": int(time.time() * 1000), "difficulty": level, "count": count, "focus": bool(missed)}
    folder = os.path.expanduser("~/.cache/cockpit/quiz")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, name + ".tmp"), "w") as f:
        json.dump(out, f)
    os.replace(os.path.join(folder, name + ".tmp"), os.path.join(folder, name))
    return out


def marked(kind, slug, number, model, fn):
    """Runs `fn` with a marker beside its file while it works (<name>.running: {model, pid, at}), so the PR page shows it in
    progress from any copy, and leaves <name>.error when it fails; meant to run detached (nohup ... &)."""
    folder = os.path.join(os.path.expanduser("~/.cache/cockpit"), kind)
    os.makedirs(folder, exist_ok=True)
    name = os.path.join(folder, f"{slug.replace('/', '__')}__{number}.json")
    for old in (name + ".error",):
        if os.path.exists(old):
            os.remove(old)
    with open(name + ".running", "w") as f:
        json.dump({"model": model, "pid": os.getpid(), "at": int(time.time() * 1000)}, f)
    try:
        return fn()
    except Exception as e:
        with open(name + ".error", "w") as f:
            json.dump({"error": str(e)[:400], "model": model, "at": int(time.time() * 1000)}, f)
        raise
    finally:
        if os.path.exists(name + ".running"):
            os.remove(name + ".running")


def main():
    a = sys.argv[1:]
    try:
        if len(a) >= 4 and a[0] == "pr":
            print(json.dumps(marked("explain", a[1], a[2], a[3], lambda: explain_pr(a[1], a[2], a[3]))))
        elif len(a) >= 3 and a[0] == "fill":
            print(json.dumps(fill(a[1], a[2])))
        elif len(a) >= 4 and a[0] == "quiz":
            missed = json.load(open(a[a.index("--missed") + 1])) if "--missed" in a else None
            print(json.dumps(marked("quiz", a[1], a[2], a[3], lambda: quiz(a[1], a[2], a[3], missed))))
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
