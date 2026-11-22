import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findDshSessionCwd,
  isProjectRoot,
  listProjectCandidates,
  renderWorkspaceGuidance,
  resetSessionCache,
  resolveSessionWorkspace,
} from "../src/project/session.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muninn-" + prefix + "-")));
  roots.push(dir);
  return dir;
}

function writeSession(dshHome: string, id: string, cwd: string, mtimeMs?: number): void {
  const dir = path.join(dshHome, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session-" + id + ".json");
  fs.writeFileSync(
    file,
    JSON.stringify({ record: { identity: { cwd } } })
  );
  if (mtimeMs !== undefined) {
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  }
}

afterEach(() => {
  resetSessionCache();
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("DSH session workspace", () => {
  it("returns the cwd of the most recently updated session", () => {
    const dshHome = tempDir("dsh");
    const older = tempDir("older");
    const newer = tempDir("newer");
    writeSession(dshHome, "a", older, Date.now() - 60_000);
    writeSession(dshHome, "b", newer, Date.now());

    resetSessionCache();
    expect(findDshSessionCwd({ DSH_HOME: dshHome })).toBe(newer);
  });

  it("returns null when DSH has no session cache", () => {
    const dshHome = tempDir("dsh-empty");
    resetSessionCache();
    expect(findDshSessionCwd({ DSH_HOME: dshHome })).toBeNull();
  });

  it("recognizes project roots by marker or Git directory", () => {
    const project = tempDir("project");
    fs.mkdirSync(path.join(project, ".git"));
    expect(isProjectRoot(project)).toBe(true);

    const marked = tempDir("marked");
    fs.mkdirSync(path.join(marked, ".muninn"));
    fs.writeFileSync(path.join(marked, ".muninn", "project.json"), "{}");
    expect(isProjectRoot(marked)).toBe(true);

    const plain = tempDir("plain");
    expect(isProjectRoot(plain)).toBe(false);
  });

  it("lists candidate projects inside a workspace, including one level of nesting", () => {
    const workspace = tempDir("workspace");
    for (const name of ["one", "two"]) {
      fs.mkdirSync(path.join(workspace, name, ".git"), { recursive: true });
    }
    fs.mkdirSync(path.join(workspace, "group", "three", ".git"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "not-a-project"));

    const candidates = listProjectCandidates(workspace);
    const names = candidates.map((candidate) => candidate.name).sort();
    expect(names).toEqual(["one", "three", "two"]);
  });

  it("binds a session folder that is a project and reports candidates otherwise", () => {
    const dshHome = tempDir("dsh-resolve");
    const project = tempDir("repo");
    fs.mkdirSync(path.join(project, ".git"));
    writeSession(dshHome, "project", project);
    resetSessionCache();
    const bound = resolveSessionWorkspace({ DSH_HOME: dshHome });
    expect(bound?.projectRoot).toBe(project);
    expect(bound?.candidates).toEqual([]);

    const workspace = tempDir("container");
    fs.mkdirSync(path.join(workspace, "repo", ".git"), { recursive: true });
    writeSession(dshHome, "workspace", workspace, Date.now() + 5_000);
    resetSessionCache();
    const container = resolveSessionWorkspace({ DSH_HOME: dshHome });
    expect(container?.projectRoot).toBeNull();
    expect(container?.candidates.map((c) => c.name)).toEqual(["repo"]);

    const guidance = renderWorkspaceGuidance(container!);
    expect(guidance).toContain("# Session workspace:");
    expect(guidance).toContain("repo");
    expect(guidance).toContain('muninn_project');
    expect(guidance).toContain("muninn_bootstrap");
  });
});
