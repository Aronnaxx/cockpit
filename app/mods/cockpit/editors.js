// The editors installed on this computer, for "Open in…": VS Code, Zed, Antigravity and the like, opened on a folder.

import { exec, notify } from "herdr";

// id, app name (macOS), label
export const EDITORS = [["vscode", "Visual Studio Code", "VS Code"], ["zed", "Zed", "Zed"], ["antigravity", "Antigravity", "Antigravity"], ["antigravity-ide", "Antigravity IDE", "Antigravity IDE"], ["cursor", "Cursor", "Cursor"], ["windsurf", "Windsurf", "Windsurf"]];

/** The ones that are installed. */
export async function installedEditors() {
  try {
    const r = await exec("sh", ["-c", "ls /Applications ~/Applications 2>/dev/null"], { timeout: 10000 });
    const have = new Set(String(r.stdout).split("\n").map((n) => n.replace(/\.app$/, "")));
    return EDITORS.filter(([, app]) => have.has(app));
  } catch {
    return [];
  }
}

/** Opens `folder` in the editor `id`. */
export async function openInEditor(id, folder) {
  const app = EDITORS.find(([e]) => e === id)?.[1];
  if (!app) return false;
  try {
    await exec("open", ["-a", app, folder], { timeout: 20000 });
    notify({ title: `Opened in ${app}`, body: folder });
    return true;
  } catch (e) {
    notify({ title: "Could not open it", body: String(e?.message ?? e).slice(0, 160) });
    return false;
  }
}
