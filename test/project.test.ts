import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  PROJECT_MARKER_DIR,
  PROJECT_MARKER_FILE,
  deriveProjectUid,
  findGitCommonRoot,
  findProjectMarker,
  memoryDbPath,
  memoryJsonlPath,
  muninnHome,
  normalizeGitRemote,
  projectStorageDir,
  readProjectMarker,
  readRegistry,
  registerProjectContext,
  resolveProjectContext,
  writeProjectMarker,
} from "../src/project/identity.js";
import {
  ensureProject,
  getDatabase,
  resolveDatabasePath,
} from "../src/db/client.js";
import { findLegacyDatabases, migrateOne } from "../src/commands/project.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `muninn-${prefix}-`)));
  roots.push(dir);
  return dir;
}

function gitRepo(name: string, remote?: string): string {
  const dir = tempDir(name);
  spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Muninn Test"], { cwd: dir });
  if (remote) {
    spawnSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  }
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
  delete process.env.MUNINN_LEGACY_STORAGE;
});

describe("Portable project identity", () => {
  it("uses the committed marker uid and name", () => {
    const dir = tempDir("marker");
    writeProjectMarker(dir, { uid: "uid-marker-1", name: "My Project" });

    const marker = readProjectMarker(dir);
    expect(marker).toEqual({ version: 1, uid: "uid-marker-1", name: "My Project" });

    // Lexical walk-up: a not-yet-created subdirectory still finds the marker.
    const hit = findProjectMarker(path.join(dir, "nested", "deeper"));
    expect(hit?.dir).toBe(dir);

    const context = resolveProjectContext({ explicitRoot: dir });
    expect(context.uid).toBe("uid-marker-1");
    expect(context.name).toBe("My Project");
    expect(context.source).toBe("marker");
    expect(context.markerPath).toBe(
      path.join(dir, PROJECT_MARKER_DIR, PROJECT_MARKER_FILE)
    );
  });

  it("derives a stable uid from the git remote so clones share memory", () => {
    const root = tempDir("clone-root");
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(
      path.join(root, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:dahch/portable.git\n'
    );
    const clone = tempDir("clone-copy");
    fs.mkdirSync(path.join(clone, ".git"));
    fs.writeFileSync(
      path.join(clone, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/dahch/portable.git\n'
    );

    const first = resolveProjectContext({ explicitRoot: root });
    const second = resolveProjectContext({ explicitRoot: clone });
    expect(first.kind).toBe("git");
    expect(second.uid).toBe(first.uid);
    expect(second.uid.startsWith("g-")).toBe(true);
  });

  it("gives non-git directories distinct uids and separate storage", () => {
    const first = tempDir("plain-a");
    const second = tempDir("plain-b");
    const a = resolveProjectContext({ explicitRoot: first });
    const b = resolveProjectContext({ explicitRoot: second });
    expect(a.kind).toBe("directory");
    expect(a.uid).not.toBe(b.uid);
    expect(memoryDbPath(a.uid)).not.toBe(memoryDbPath(b.uid));
  });

  it("normalizes SSH and HTTPS remotes to the same identity", () => {
    expect(normalizeGitRemote("git@github.com:dahch/portable.git")).toBe(
      "github.com/dahch/portable"
    );
    expect(normalizeGitRemote("https://github.com/dahch/portable.git")).toBe(
      "github.com/dahch/portable"
    );
    // Different hosts and paths must not collapse into the same identity.
    expect(normalizeGitRemote("https://gitlab.com/dahch/portable.git")).toBe(
      "gitlab.com/dahch/portable"
    );
  });

  it("unifies a linked worktree with its main repository", () => {
    const main = gitRepo("worktree-main", "https://github.com/dahch/worktree-demo.git");
    const worktreeParent = tempDir("worktree-parent");
    const worktreePath = path.join(worktreeParent, "feature");
    const result = spawnSync(
      "git",
      ["worktree", "add", "-q", worktreePath, "-b", "feature"],
      { cwd: main, encoding: "utf8" }
    );
    if (result.status !== 0) return; // older git without -b support: skip silently
    roots.push(worktreePath);

    expect(findGitCommonRoot(worktreePath)).toBe(main);
    const mainContext = resolveProjectContext({ explicitRoot: main });
    const worktreeContext = resolveProjectContext({ explicitRoot: worktreePath });
    expect(worktreeContext.rootPath).toBe(main);
    expect(worktreeContext.uid).toBe(mainContext.uid);
    expect(worktreeContext.kind).toBe("git");
    expect(worktreeContext.gitRemote).toBe("https://github.com/dahch/worktree-demo.git");
  });

  it("uses the registry to resolve a subdirectory of a non-git project", () => {
    const root = tempDir("registered");
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    const context = resolveProjectContext({ explicitRoot: root });
    registerProjectContext(context);

    const fromNested = resolveProjectContext({ explicitRoot: nested });
    expect(fromNested.rootPath).toBe(root);
    expect(fromNested.uid).toBe(context.uid);
    expect(fromNested.source).toBe("registry");
  });

  it("refuses to write a marker through a symlink", () => {
    const dir = tempDir("marker-symlink");
    const outside = tempDir("marker-outside");
    const markerDir = path.join(dir, PROJECT_MARKER_DIR);
    fs.mkdirSync(markerDir);
    fs.symlinkSync(path.join(outside, "victim.json"), path.join(markerDir, PROJECT_MARKER_FILE));
    expect(() => writeProjectMarker(dir, { uid: "uid-symlink" })).toThrow(/symlink/i);
    expect(fs.existsSync(path.join(outside, "victim.json"))).toBe(false);
  });

  it("resolves the database to portable per-project storage and keeps legacy opt-in", () => {
    const dir = tempDir("db-path");
    const context = resolveProjectContext({ explicitRoot: dir });
    expect(resolveDatabasePath(undefined, dir)).toBe(memoryDbPath(context.uid));
    expect(resolveDatabasePath(undefined, dir).startsWith(muninnHome())).toBe(true);

    process.env.MUNINN_LEGACY_STORAGE = "1";
    expect(resolveDatabasePath(undefined, dir)).toBe(
      path.join(os.homedir(), ".huginn", "muninn.db")
    );
  });

  it("adopts the existing project row when the folder moves (marker uid)", () => {
    const original = tempDir("move-original");
    const moved = tempDir("move-target");
    const uid = "uid-moved-project";
    writeProjectMarker(moved, { uid, name: "Moved" });

    const db = getDatabase(":memory:");
    try {
      const first = ensureProject(db, {
        rootPath: original,
        uid,
        name: "Moved",
        startDir: original,
      });
      const adopted = ensureProject(db, {
        rootPath: moved,
        uid,
        name: "Moved",
        startDir: moved,
      });
      expect(adopted.id).toBe(first.id);
      expect(adopted.root_path).toBe(moved);
      const count = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM projects").get();
      expect(count?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("derives the same uid from a path regardless of trailing separators", () => {
    const dir = tempDir("uid-path");
    const a = deriveProjectUid({ gitRemote: null, rootPath: dir });
    const b = deriveProjectUid({ gitRemote: null, rootPath: `${dir}///` });
    expect(a).toBe(b);
  });
});

describe("Legacy migration", () => {
  function createLegacyDb(projectRoot: string): string {
    const legacyPath = path.join(projectRoot, ".huginn", "muninn.db");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacy = new Database(legacyPath);
    try {
      legacy.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          git_remote TEXT,
          root_path TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE observations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          topic_key TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE entities (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          identifier TEXT NOT NULL,
          file_path TEXT NOT NULL
        );
        CREATE TABLE observation_entities (
          observation_id TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          PRIMARY KEY(observation_id, entity_id)
        );
        CREATE TABLE entity_dependencies (
          source_entity_id TEXT NOT NULL,
          target_entity_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          PRIMARY KEY(source_entity_id, target_entity_id, relation_type)
        );
      `);
      legacy
        .prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)")
        .run("legacy-project", "Legacy Project", projectRoot);
      legacy
        .prepare(
          "INSERT INTO observations (id, project_id, category, title, content, topic_key) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("legacy-obs", "legacy-project", "decision", "Legacy decision", "Body", "topic");
      legacy
        .prepare(
          "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
        )
        .run("legacy-entity", "legacy-project", "function", "src/a.ts::run", "src/a.ts");
      legacy
        .prepare(
          "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
        )
        .run("legacy-obs", "legacy-entity");
      legacy
        .prepare(
          "INSERT INTO entity_dependencies (source_entity_id, target_entity_id, relation_type) VALUES (?, ?, ?)"
        )
        .run("legacy-entity", "legacy-entity", "references");
    } finally {
      legacy.close();
    }
    return legacyPath;
  }

  it("copies observations, entities, links and dependencies into portable storage", () => {
    const root = tempDir("migrate");
    const legacyPath = createLegacyDb(root);
    const uid = resolveProjectContext({ explicitRoot: root }).uid;

    const report = migrateOne(legacyPath, false);
    expect(report.projects).toBe(1);
    expect(report.observationsImported).toBe(1);
    expect(report.entitiesImported).toBe(1);
    expect(report.linksImported).toBe(1);
    expect(report.dependenciesImported).toBe(1);

    const target = new Database(memoryDbPath(uid), { readonly: true });
    try {
      const observation = target
        .prepare<[], { title: string; status: string }>(
          "SELECT title, status FROM observations"
        )
        .get();
      expect(observation?.title).toBe("Legacy decision");
      expect(observation?.status).toBe("active");
      const entity = target
        .prepare<[], { identifier: string }>("SELECT identifier FROM entities")
        .get();
      expect(entity?.identifier).toBe("src/a.ts::run");
      const project = target
        .prepare<[], { uid: string; root_path: string }>(
          "SELECT uid, root_path FROM projects"
        )
        .get();
      expect(project?.uid).toBe(uid);
      expect(project?.root_path).toBe(root);
    } finally {
      target.close();
    }
  });

  it("is idempotent and never modifies the legacy database", () => {
    const root = tempDir("migrate-twice");
    const legacyPath = createLegacyDb(root);
    const before = fs.readFileSync(legacyPath);

    migrateOne(legacyPath, false);
    const second = migrateOne(legacyPath, false);
    expect(second.projects).toBe(1);
    expect(second.observationsImported).toBe(0);
    expect(second.observationsSkipped).toBe(1);
    expect(second.entitiesImported).toBe(0);
    expect(second.entitiesReused).toBe(1);
    expect(fs.readFileSync(legacyPath)).toEqual(before);
  });

  it("does not write anything in a dry run", () => {
    const root = tempDir("migrate-dry");
    const legacyPath = createLegacyDb(root);
    const uid = resolveProjectContext({ explicitRoot: root }).uid;
    const report = migrateOne(legacyPath, true);
    expect(report.dryRun).toBe(true);
    expect(report.observationsImported).toBe(1);
    expect(fs.existsSync(memoryDbPath(uid))).toBe(false);
  });
});

describe("Registry", () => {
  it("merges paths for the same uid and stores remotes", () => {
    const dir = tempDir("registry");
    const context = resolveProjectContext({ explicitRoot: dir });
    registerProjectContext({ ...context, name: "Registry Project" });
    registerProjectContext({ ...context, rootPath: path.join(dir, "alias") });

    const registry = readRegistry();
    const entry = registry.projects.find((item) => item.uid === context.uid);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("Registry Project");
    expect(entry!.rootPaths).toContain(dir);
    expect(entry!.rootPaths).toContain(path.join(dir, "alias"));
  });

  it("places storage under the isolated MUNINN_HOME", () => {
    const dir = tempDir("storage-home");
    const context = resolveProjectContext({ explicitRoot: dir });
    expect(projectStorageDir(context.uid)).toBe(
      path.join(muninnHome(), "projects", context.uid)
    );
    expect(memoryJsonlPath(context.uid)).toBe(
      path.join(projectStorageDir(context.uid), "memories.jsonl")
    );
  });
});
describe("Legacy scan", () => {
  it("finds nested .huginn databases and skips dependency trees", () => {
    const root = tempDir("scan");
    const project = path.join(root, "proj");
    fs.mkdirSync(path.join(project, ".huginn"), { recursive: true });
    fs.writeFileSync(path.join(project, ".huginn", "muninn.db"), "");
    fs.mkdirSync(path.join(project, "node_modules", ".huginn"), { recursive: true });
    fs.writeFileSync(path.join(project, "node_modules", ".huginn", "muninn.db"), "");

    const found = findLegacyDatabases(root);
    expect(found).toEqual([path.join(project, ".huginn", "muninn.db")]);
  });
});
