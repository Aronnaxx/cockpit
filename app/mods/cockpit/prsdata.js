// Your pull requests and the ones you review (bin/cockpit-prs.py, asked of GitHub through `gh`): one place reads them, shares
// them through Herdr's shared state so every view draws the same, and counts how many wait on you for the tab's badge.

import { exec, readTextFile, setShared, shared } from "herdr";
import * as hub from "./hub.js";

let running = null;

/** Asks for the pull requests again (GitHub is asked at most once a minute unless `force`); resolves to the data. */
export function loadPrs({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    try {
      const { home } = await hub.install();
      const r = await exec("python3", [`${home}/.local/share/cockpit/herdr/helpers/cockpit-prs.py`, ...(force ? ["--force"] : [])], { timeout: 90000 });
      const d = JSON.parse(r.stdout || "null");
      if (d) {
        setShared("cockpit.prs", d);
        const mine = (d.mine ?? []).filter((p) => p.turn?.who === "you").length;
        const reviews = (d.assigned ?? []).filter((p) => p.turn?.who === "you").length;
        const n = mine + reviews;
        setShared("badge.prs", n ? { count: n, tone: "warning" } : null);
      }
      return d;
    } catch {
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** What was last read (null before the first answer). */
export const prs = () => shared("cockpit.prs") ?? null;

/** The cockpit config, for prs.required and prs.repos. */
export async function prsConfig() {
  try {
    const { home } = await hub.install();
    return JSON.parse((await readTextFile(`${home}/.config/cockpit/config.json`)) ?? "{}");
  } catch {
    return {};
  }
}

/** "5m", "3d": how long ago. */
export function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? "now" : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}
