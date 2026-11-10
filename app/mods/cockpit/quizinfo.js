// Where each pull request's quiz stands, for the PR list, Home's cards and the Post button: shared by the PRs page (it reads
// ~/.cache/cockpit/quiz/ with the review drafts) as `cockpit.quiz` = {gate: {on, pass}, prs: {"owner/name#n": {answered,
// right, total, stale}}}. The gate is quiz.gate and quiz.pass (a percentage) in the cockpit config: posting a review waits
// for a passed quiz.

import { shared } from "herdr";

export function quizOf(key) {
  return shared("cockpit.quiz")?.prs?.[key] ?? null;
}

export function quizGate() {
  return shared("cockpit.quiz")?.gate ?? { on: false, pass: 75 };
}

/** Whether the quiz lets you post: {ok, why}. Without the gate on, always. */
export function gateFor(key) {
  const g = quizGate();
  if (!g.on) return { ok: true };
  const q = quizOf(key);
  if (!q?.total) return { ok: false, why: `Take the quiz first: posting needs ${g.pass}% on it (Settings › AI)` };
  if (q.answered < q.total) return { ok: false, why: `Finish the quiz first: ${q.total - q.answered} question${q.total - q.answered === 1 ? "" : "s"} left, ${g.pass}% needed` };
  const pct = Math.round((q.right / q.total) * 100);
  return pct >= g.pass ? { ok: true } : { ok: false, why: `${pct}% on the quiz, ${g.pass}% needed: Quiz again or New questions on what you missed` };
}

/** A chip's words and tone for the quiz: not taken, under way, passed or not ({label, tone, tooltip}), or null with no quiz. */
export function quizChip(key, hasDraft = false) {
  const q = quizOf(key);
  const g = quizGate();
  if (!q?.total) return hasDraft ? { label: "QUIZ: NOT TAKEN", tone: g.on ? "warning" : "muted", tooltip: g.on ? `Posting needs ${g.pass}% on the quiz` : "Quiz me is on the PR page" } : null;
  if (q.answered < q.total) return { label: `QUIZ ${q.answered}/${q.total} ANSWERED`, tone: "info", tooltip: `${q.answered} of ${q.total} answered` };
  const pct = Math.round((q.right / q.total) * 100);
  const passed = pct >= (g.on ? g.pass : 75);
  return { label: `QUIZ ${q.right}/${q.total} RIGHT`, tone: passed ? "success" : "destructive", tooltip: `${pct}%${g.on ? `, ${g.pass}% needed to post` : ""}${q.stale ? " · written for an older head" : ""}` };
}
