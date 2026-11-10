// Starts an agent in a new tab with a first message: the agent is picked (Codex, Antigravity, OpenCode, Claude Code), and
// cockpit builds its own command line for it (`cockpit agent argv start`), with a model when one is chosen.

import { exec, run, notify } from "herdr";
import * as hub from "./hub.js";

/** The agents a person can pick for a pull request's work. */
export const LAUNCH_AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "antigravity-cli", label: "Antigravity" },
];

/** The agent last picked, so a plain click repeats it. */
export function lastAgent() {
  try {
    return localStorage.getItem("cockpit.launch.agent") ?? "opencode";
  } catch {
    return "opencode";
  }
}

/** Starts `agent` in a new tab named `name`, in `folder`, with `prompt` as its first message. */
export async function launchAgent({ agent, prompt, folder, name, model = null }) {
  try {
    localStorage.setItem("cockpit.launch.agent", agent);
  } catch {}
  const { home } = await hub.install();
  const args = ["agent", "argv", "start", "--agent", agent, "--prompt", prompt, ...(model ? ["--model", model] : [])];
  const r = await exec(`${home}/.local/bin/cockpit`, args, { timeout: 15000 }).catch((e) => ({ stdout: "", stderr: String(e?.message ?? e) }));
  const line = String(r.stdout ?? "").trim();
  if (!line) {
    notify({ title: "Could not start the agent", body: String(r.stderr ?? "").trim().slice(0, 160) || `${agent} has no way to start with a prompt` });
    return false;
  }
  run("tab.new", { name, folder: folder?.replace(/^~/, home), argv: ["sh", "-lc", line] });
  run("layout.select", { stack: "center", child: "work" });
  return true;
}

/** Where a repository's checkout is: `prs.repos` in the cockpit config ({"owner/name": "~/path"}), else ~/<name>. */
export function repoFolder(repo, cfg) {
  return cfg?.prs?.repos?.[repo] ?? `~/${String(repo).split("/")[1]}`;
}

/** The first message for work on a pull request. `kind`: fix (its review comments and CI), rebase, review, rereview. */
export function prPrompt(kind, p) {
  const where = `${p.repo}#${p.number} (${p.url}), branch ${p.branch}`;
  const rules = "Always rebase onto main, never merge it: `git fetch origin main && git rebase origin/main`, then `git push --force-with-lease`. Do not publish any review or comment without my say-so.";
  if (kind === "rebase")
    return `Bring ${where} up to date with main by rebasing. Work in a git worktree on that branch (\`gh pr checkout ${p.number}\` in the repo's checkout, or \`git worktree add\`). ${rules} In a repo with generated files (lockfiles, Cargo.nix, generated proto code), take main's side while replaying, then regenerate once at the tip. Tell me what conflicted and what you did.`;
  const draft = `~/.cache/cockpit/review-drafts/${String(p.repo).replace("/", "__")}__${p.number}.json`;
  const shape = `Write your findings as a review DRAFT in ${draft} (create the folder if needed), as JSON: {"summary": "short overall note", "verdict": "COMMENT" | "APPROVE" | "REQUEST_CHANGES", "comments": [{"path": "file", "line": 12, "body": "the comment"}, {"reply_to": <review comment id>, "quote": "what it replies to", "body": "the reply"}]}. Keep each comment short and specific, with the real path and the line number in the new version of the file. NEVER post anything to GitHub yourself (no gh pr review, no gh api writes, no comments): I read the draft in the Cockpit, edit it and post it.`;
  if (kind === "review")
    return `Review ${where}: read its diff and discussion (\`gh pr diff ${p.number}\`, \`gh pr view ${p.number} --comments\`), then find the bugs and risks, most serious first. ${shape}`;
  if (kind === "rereview")
    return `I was asked to review ${where} again. Do a re-review, not a full pass: look only at what changed since my last review (the commits after it: \`gh pr view ${p.number} --json commits,reviews\`, then \`git diff <my last reviewed commit>..HEAD\`), and check whether the points I raised then are addressed. ${shape}`;
  const ci = p.ci?.failed?.length ? ` CI failed: ${p.ci.failed.map((f) => f.name).join("; ")}.` : "";
  return `Work on ${where}: read its review comments (\`gh pr view ${p.number} --comments\` and the review threads), address them, and push.${ci} ${rules} For each thread you addressed, also put a short suggested reply in the review draft ${`~/.cache/cockpit/review-drafts/${String(p.repo).replace("/", "__")}__${p.number}.json`} as JSON {"summary": "", "verdict": "COMMENT", "comments": [{"reply_to": <the thread's first review comment id>, "quote": "what it says", "body": "the reply"}]} (merge into the file if it exists). Never post replies to GitHub yourself: I edit and post them from the Cockpit.`;
}
