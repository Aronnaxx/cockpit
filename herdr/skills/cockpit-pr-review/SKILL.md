---
name: cockpit-pr-review
description: Review a GitHub pull request for the Cockpit (Herdr) and write the result as files the Cockpit shows - a review draft with line comments and the reason for each, and an explanation of the PR - never posting anything to GitHub. Use whenever a prompt says it comes from the Cockpit, names a file in ~/.cache/cockpit/review-drafts/ or ~/.cache/cockpit/explain/, or asks to review, re-review or draft replies on a pull request "for the Cockpit".
---

# Reviewing a pull request for the Cockpit

The person reads, edits and posts your review from the Cockpit's PR page. Your job is to leave two files there, and nothing on GitHub.

**Never post to GitHub.** No `gh pr review`, no `gh pr comment`, no `gh api` call that writes (POST, PATCH, PUT, DELETE), no pushes unless the prompt's task is to fix and push. Reading is fine: `gh pr view`, `gh pr diff`, `gh api` GETs, the code in your worktree.

You start in a git worktree on the PR's branch, at its head. Read the real code there (callers, tests, the files around a change), not only the diff.

## The kinds of task

- **review**: a full review. Read the diff (`gh pr diff <n>`) and the discussion (`gh pr view <n> --comments`), then find the bugs and risks, most serious first.
- **rereview**: you were asked to review again. Look only at what changed since the person's last review (`gh pr view <n> --json commits,reviews`, then `git diff <last reviewed commit>..HEAD`), and say whether the points raised then are addressed.
- **fix** (the person's own PR): address the review threads and push; draft a short reply to each thread you addressed (`reply_to`, below).

## File 1: the review draft

Path: `~/.cache/cockpit/review-drafts/<owner>__<repo>__<number>.json` (the prompt gives it; make the folder if needed). If the file exists, merge into it: keep what is there unless you are replacing your own earlier comment. When you rewrite a comment (its wording, say), keep every field you did not mean to change: `start_line`, `why`, `explained`. Dropping `start_line` turns a range into one line.

```json
{
  "summary": "two or three sentences: what you think of it overall and the main risk",
  "verdict": "COMMENT",
  "comments": [
    {"path": "src/a.rs", "line": 94, "start_line": 91, "body": "the comment", "why": "your reason"},
    {"reply_to": 123456789, "quote": "what the thread says", "body": "the reply"}
  ]
}
```

- `verdict`: `COMMENT`, `APPROVE` or `REQUEST_CHANGES`. Use `COMMENT` unless the prompt or the findings clearly call for another.
- `path` is the file's path in the repo. `line` is the line in the **new** version of the file (the PR's head). For several lines, `start_line` is the first and `line` the last. Comment on the lines the problem is in, not a function's signature far from it.
- `body` is what gets posted, in the person's voice: short, specific, one point per comment, with a suggested fix when there is an obvious one. No praise padding, no "nit:" pile-ups; fold small nits into one comment.
- **`why` on every line comment** (never posted, it is for the person): two or three sentences on what led you to it, meaning the code paths, callers or tests you read and what you ran, and how sure you are (high, medium or low). Say plainly when you did not run or verify something.
- `reply_to` is the id of a review thread's first comment (`gh api repos/<owner>/<repo>/pulls/<n>/comments`), for replies only.

Write the file as you go (after each finding, rewriting the whole file), so the person sees comments appear.

## File 2: the explanation

Path: `~/.cache/cockpit/explain/<owner>__<repo>__<number>.json`. Write it once you understand the change, for a reader who did not write it: describe, never judge (the judging goes in the draft). Skip it on a rereview or a fix if the file already exists.

```json
{
  "headline": "one sentence: what the change does for its users or callers",
  "summary": "markdown, one to three short paragraphs: the problem, the approach, what is different afterwards",
  "before_after": [{"aspect": "a behaviour, an API, a limit", "before": "on the base branch", "after": "with the change"}],
  "diagram": {
    "title": "the flow it changes", "caption": "one sentence", "direction": "down",
    "nodes": [{"id": "a", "label": "Short label\nsecond line", "kind": "box", "changed": true}],
    "edges": [{"from": "a", "to": "b", "label": ""}]
  },
  "areas": [{"name": "Telemetry query", "what": "one sentence", "files": ["exact/path/from/the/diff.rs"]}],
  "watch": ["up to four things a reader signs up for by accepting it"],
  "model": "the agent and model you are"
}
```

- `before_after`: three to six rows. `diagram`: 5 to 16 nodes; `kind` is `box`, `round` (an entry or an end) or `decision` (a branch); `changed: true` on the steps this PR adds or alters; `direction` is `down`, or `right` for a pipeline. `areas`: two to seven, every changed file in one of them, with exact paths. The Cockpit counts the lines per area itself.

## When you are done

Say in the terminal: how many comments, the verdict, the single most important finding, and that both files are written. Do not post.
