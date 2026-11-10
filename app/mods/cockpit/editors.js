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

/** Opens a file of a checkout at a line: VS Code (and its scheme) goes to the line, the others open the file. */
export async function openFileAt(id, folder, rel, line = 1) {
  const abs = `${folder}/${rel}`;
  if (id === "vscode") {
    try {
      await exec("open", [`vscode://file${abs}:${line}`], { timeout: 20000 });
      return true;
    } catch {}
  }
  return openInEditor(id, abs);
}

/** The pull request's "Files changed" on GitHub at a file (and a line of its new version): its anchor is the SHA-256 of the path. */
export async function githubFileUrl(p, path, line = null) {
  const r = await exec("python3", ["-c", "import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest())", path], { timeout: 10000 });
  return `${p.url}/files#diff-${String(r.stdout).trim()}${line ? `R${line}` : ""}`;
}
