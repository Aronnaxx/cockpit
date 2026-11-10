// Split views: a pull request's page beside the agent you are on, in the same tab (Herdr's own panes, so
// they resize, zoom to full size and close from the pane header like any pane). The center switches to the tab's panes, since
// the one-agent view shows a single terminal.

import { run, focused, agents, panes, setShared } from "herdr";
import { show } from "./sidebar.js";

/** The pane to split: the focused agent's (or `terminal`'s), in the tab shown. */
function anchor(terminal = null) {
  const f = focused();
  const t = terminal ?? agents().find((a) => a.focused)?.address ?? f?.terminal ?? null;
  return panes().find((p) => t && p.terminal === t) ?? panes().find((p) => p.pane === f?.pane) ?? null;
}

function toTab() {
  run("layout.select", { stack: "view", child: "main" });
  setShared("cockpit.view", "main");
  show("work");
}

/** The pull request's page in a pane to the right of the agent working on it (`terminal`, else the focused agent). */
export function prBeside(p, terminal = null) {
  const at = anchor(terminal);
  toTab();
  run("pane.split", { direction: "right", ...(at ? { pane: at.pane } : {}), mod: "cockpit", props: { app: "prs", pr: `${p.repo}#${p.number}`, docked: true } });
}
