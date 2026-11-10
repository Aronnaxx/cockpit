// Starts an agent in a new tab with a first message: the agent is picked (Codex, Antigravity, OpenCode, Claude Code), and
// cockpit builds its own command line for it (`cockpit agent argv start`), with a model when one is chosen.

import { exec, run, notify, spaces } from "herdr";
import * as hub from "./hub.js";
import { prsConfig } from "./prsdata.js";

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

/** The pull request's worktree on its own branch (made, or brought to its latest head): where an agent on the PR works, so Herdr's
 *  own PR and Changes views see the branch. The repository's checkout when it cannot be made. */
export async function prWorktree(p, cfg) {
  const { home } = await hub.install();
  const folder = repoFolder(p.repo, cfg).replace(/^~/, home);
  try {
    const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-worktree.py`, p.repo, String(p.number), folder, "--branch", p.branch], { timeout: 400000 });
    const d = JSON.parse(r.stdout || "{}");
    if (d.path) return d.path;
  } catch {}
  return folder;
}

/** A new tab in the space named after the repository (made when there is none), so a repository's agents and worktrees sit together. */
export function openInSpace(spaceName, { name, folder, argv, task }) {
  const here = spaces().find((s) => s.name === spaceName && !s.machine);
  if (here) {
    run("space.select", { id: here.id });
    run("tab.new", { name, space: here.id, folder, ...(argv ? { argv } : {}), ...(task ? { task } : {}) });
  } else run("space.new", { name: spaceName, folder, tab: name, ...(argv ? { argv } : {}), ...(task ? { task } : {}) });
  run("layout.select", { stack: "center", child: "work" });
}

/** Starts `agent` in a new tab named `name`, in `folder`, with `prompt` as its first message. */
export async function launchAgent({ agent, prompt, folder, name, model = null, repoName = null }) {
  try {
    localStorage.setItem("cockpit.launch.agent", agent);
  } catch {}
  const { home } = await hub.install();
  // OpenCode's interactive command has no model flag (only `opencode run` does): the model goes in the folder's project config.
  const viaEnv = agent === "opencode" && model;
  const args = ["agent", "argv", "start", "--agent", agent, "--prompt", prompt, ...(model && !viaEnv ? ["--model", model] : [])];
  const r = await exec(`${home}/.local/bin/cockpit`, args, { timeout: 15000 }).catch((e) => ({ stdout: "", stderr: String(e?.message ?? e) }));
  let line = String(r.stdout ?? "").trim();
  if (line && viaEnv) {
    const w = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-opencode-model.py`, folder?.replace(/^~/, home) ?? home, model], { timeout: 15000 }).catch(() => null);
    const res = w ? JSON.parse(w.stdout || "{}") : {};
    if (res.error) notify({ title: "OpenCode keeps its own model here", body: res.error });
  }
  if (!line) {
    notify({ title: "Could not start the agent", body: String(r.stderr ?? "").trim().slice(0, 160) || `${agent} has no way to start with a prompt` });
    return false;
  }
  openInSpace(repoName ?? name.split(" ").pop().split("#")[0], { name, folder: folder?.replace(/^~/, home), argv: ["sh", "-lc", line] });
  return true;
}

/** A gateway model as the agent names it: OpenCode reaches the gateway as its provider `litellm`, so litellm/<id>. */
export function agentModel(agent, model) {
  const m = String(model ?? "").trim();
  if (!m) return null;
  return agent === "opencode" && !m.startsWith("litellm/") ? `litellm/${m}` : m;
}

/** A review of a pull request, from wherever it is asked (the PR page, the inbox): in the PR's worktree on its branch, with the
 *  prompt that has the agent write the review draft (never post), in a tab named "review <repo>#<n>" so the PR page, Home and the
 *  Comments panel follow it. A re-review when you were asked again; replies to the threads on your own PR. */
export async function reviewPr(p, { agent = lastAgent(), model = null } = {}) {
  const cfg = await prsConfig();
  const kind = p.role === "author" ? "fix" : p.turn?.why === "re-review" || p.turn?.why === "re-requested" ? "rereview" : "review";
  return launchAgent({ agent, model, prompt: prPrompt(kind, p), folder: await prWorktree(p, cfg), name: `${kind} ${p.repo.split("/")[1]}#${p.number}` });
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
  const file = `${String(p.repo).replace("/", "__")}__${p.number}.json`;
  const draft = `~/.cache/cockpit/review-drafts/${file}`;
  // What a review draft holds and how (the format, the reasons, the explanation) is the cockpit-pr-review skill's; the prompt names
  // the task and the files, and keeps the one rule that must never be missed.
  const files = `Use your cockpit-pr-review skill. Write the comments in my voice: ~/.config/cockpit/voice-pr-review.md. The review draft: ${draft}. The explanation: ~/.cache/cockpit/explain/${file}. Never post anything to GitHub: I edit and post it from the Cockpit. (Without that skill: write the draft as JSON {"summary", "verdict", "comments": [{"path", "line", "start_line"?, "body", "why"}]}, lines in the new file, a "why" on each comment saying what led you to it.)`;
  if (kind === "conflicts")
    return `${where} conflicts with main in: ${(p.conflicts ?? []).join(", ") || "some files"}. Rebase it onto main (never merge) in a git worktree and resolve those conflicts. ${rules} For generated files (Cargo.nix, lock files, generated proto code), take main's side while replaying, then regenerate once at the tip with the repo's own command rather than editing by hand. Tell me what conflicted and how you resolved each file; do not push if the build or tests fail.`;
  if (kind === "review") return `Review ${where} for the Cockpit (task: review). ${files}`;
  if (kind === "rereview") return `I was asked to review ${where} again: re-review it for the Cockpit (task: rereview), only what changed since my last review and whether my points are addressed. ${files}`;
  const ci = p.ci?.failed?.length ? ` CI failed: ${p.ci.failed.map((f) => f.name).join("; ")}.` : "";
  return `Work on ${where} for the Cockpit (task: fix): address its review threads and push.${ci} ${rules} Draft a short reply to each thread you addressed in the review draft (reply_to entries). ${files}`;
}
