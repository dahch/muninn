/**
 * `muninn project` and `muninn migrate` — the portable identity surface.
 *
 * `muninn project` answers the question every other agent integration needs:
 * "which project is this directory, and where does its memory live?" It is
 * read-only unless the caller asks to register, rename, forget or purge.
 *
 * `muninn migrate` is the one-time bridge from the legacy layout
 * (`<repo>/.huginn/muninn.db` and the shared `~/.huginn/muninn.db`) to the
 * portable per-project storage. It never deletes the legacy files.
 */
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import Database from "better-sqlite3";
import {
  findRegistryMatch,
  forgetRegistryEntry,
  isValidUid,
  legacyHomeDbPath,
  legacyProjectDbPath,
  memoryDbPath,
  projectStorageDir,
  readRegistry,
  registerProjectContext,
  renameRegistryEntry,
  resolveProjectContext,
  writeProjectMarker,
  type ProjectContext,
  type RegistryEntry,
} from "../project/identity.js";
import { ensureProject, getDatabase } from "../db/client.js";

const SCAN_SKIP = new Set([
  "node_modules",
  ".git",
  ".muninn",
  ".harness",
  "dist",
  "build",
  ".cache",
  "target",
]);
const MAX_SCAN_DEPTH = 6;

export function printProjectUsage(): void {
  console.log(`muninn project — resolve and manage portable project identity

Usage:
  muninn project resolve [path] [--json]
  muninn project list [--json]
  muninn project register [path]
  muninn project rename <name> [--project <path>]
  muninn project forget <uid|path> [--purge --force]

Identity lives in <project>/.muninn/project.json (committed). Memory lives in
$MUNINN_HOME/projects/<uid>/memory.db (default ~/.muninn).
`);
}

export function printMigrateUsage(): void {
  console.log(`muninn migrate — move legacy Huginn-era memory into portable storage

Usage:
  muninn migrate [--from <db>] [--scan <dir>] [--dry-run] [--json]

Sources (all optional, deduplicated):
  --from <db>   an explicit legacy muninn.db
  --scan <dir>  every <dir>/**/.huginn/muninn.db (bounded depth)
  default       the current project's .huginn/muninn.db and ~/.huginn/muninn.db

The legacy files are never modified or deleted.
`);
}

interface ProjectStatus {
  name: string;
  rootPath: string;
  uid: string;
  kind: string;
  gitRoot: string | null;
  gitRemote: string | null;
  markerPath: string | null;
  source: string;
  storageDir: string;
  databasePath: string;
  databaseExists: boolean;
  observations: number | null;
}

function countObservations(dbPath: string): number | null {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare<[], { n: number }>("SELECT count(*) AS n FROM observations")
        .get();
      return row?.n ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function describeProject(context: ProjectContext): ProjectStatus {
  const storageDir = projectStorageDir(context.uid);
  const databasePath = memoryDbPath(context.uid);
  const databaseExists = fs.existsSync(databasePath);
  return {
    name: context.name,
    rootPath: context.rootPath,
    uid: context.uid,
    kind: context.kind,
    gitRoot: context.gitRoot,
    gitRemote: context.gitRemote,
    markerPath: context.markerPath,
    source: context.source,
    storageDir,
    databasePath,
    databaseExists,
    observations: databaseExists ? countObservations(databasePath) : 0,
  };
}

function printProjectStatus(status: ProjectStatus): void {
  console.log(chalk.bold(status.name));
  console.log(`  Root:      ${status.rootPath}`);
  console.log(`  UID:       ${status.uid}`);
  console.log(`  Kind:      ${status.kind}`);
  if (status.gitRoot) console.log(`  Git root:  ${status.gitRoot}`);
  if (status.gitRemote) console.log(`  Remote:    ${status.gitRemote}`);
  console.log(`  Marker:    ${status.markerPath ?? chalk.dim("none (run muninn project register)")}`);
  console.log(`  Resolved:  ${status.source}`);
  console.log(`  Storage:   ${status.storageDir}`);
  console.log(
    `  Database:  ${status.databasePath} ${
      status.databaseExists ? chalk.green("(exists)") : chalk.dim("(not created yet)")
    }`
  );
  if (status.observations !== null) {
    console.log(`  Memories:  ${status.observations}`);
  }
}

function resolveTargetRoot(args: Record<string, string | boolean | undefined>, positional?: string): string {
  if (positional) return path.resolve(positional);
  if (typeof args["--project"] === "string") return path.resolve(args["--project"]);
  return process.cwd();
}

export async function handleProjectCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>,
  positionals: string[] = []
): Promise<void> {
  if (!subcommand || subcommand === "help" || args["--help"] || args["-h"]) {
    printProjectUsage();
    return;
  }
  const json = Boolean(args["--json"]);

  if (subcommand === "resolve") {
    const context = resolveProjectContext({
      explicitRoot: resolveTargetRoot(args, positionals[0]),
    });
    const status = describeProject(context);
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      printProjectStatus(status);
    }
    return;
  }

  if (subcommand === "register") {
    const context = resolveProjectContext({
      explicitRoot: resolveTargetRoot(args, positionals[0]),
    });
    const stat = (() => {
      try {
        return fs.statSync(context.rootPath);
      } catch {
        return null;
      }
    })();
    if (!stat?.isDirectory()) {
      throw new Error(`Project root does not exist or is not a directory: ${context.rootPath}`);
    }
    const markerPath = writeProjectMarker(context.rootPath, {
      uid: context.uid,
      name: context.name,
    });
    registerProjectContext({ ...context, markerPath });
    const status = describeProject({ ...context, markerPath });
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(chalk.green(`✔ Registered ${context.name} as ${context.uid}`));
      console.log(`  Marker: ${markerPath}`);
      console.log(`  Memory: ${status.databasePath}`);
    }
    return;
  }

  if (subcommand === "list") {
    const registry = readRegistry();
    const rows = registry.projects
      .slice()
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((entry: RegistryEntry) => {
        const dbPath = memoryDbPath(entry.uid);
        const exists = fs.existsSync(dbPath);
        return {
          ...entry,
          databasePath: dbPath,
          databaseExists: exists,
          observations: exists ? countObservations(dbPath) : null,
        };
      });
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("No projects registered yet. Run `muninn project register` inside a project.");
      return;
    }
    for (const row of rows) {
      const memories = row.observations === null ? "?" : String(row.observations);
      console.log(
        `${chalk.bold(row.name)} ${chalk.dim(row.uid)} — ${row.kind}, ${memories} memories`
      );
      for (const root of row.rootPaths) console.log(`  ${root}`);
    }
    return;
  }

  if (subcommand === "rename") {
    const name = positionals[0];
    if (!name || !name.trim()) {
      throw new Error("Usage: muninn project rename <name> [--project <path>]");
    }
    const context = resolveProjectContext({
      explicitRoot: resolveTargetRoot(args),
    });
    renameRegistryEntry(context.uid, name);
    if (fs.existsSync(memoryDbPath(context.uid))) {
      const db = new Database(memoryDbPath(context.uid));
      try {
        db.prepare("UPDATE projects SET name = ? WHERE uid = ?").run(name.trim(), context.uid);
      } finally {
        db.close();
      }
    }
    console.log(chalk.green(`✔ Renamed ${context.uid} to "${name.trim()}"`));
    return;
  }

  if (subcommand === "forget") {
    const target = positionals[0];
    if (!target) {
      throw new Error("Usage: muninn project forget <uid|path> [--purge --force]");
    }
    let uid = target;
    if (!isValidUid(target)) {
      uid = resolveProjectContext({ explicitRoot: path.resolve(target) }).uid;
    }
    const entry = readRegistry().projects.find((item) => item.uid === uid);
    if (!entry) {
      console.log(`No registered project with uid ${uid}.`);
      return;
    }
    forgetRegistryEntry(uid);
    if (args["--purge"]) {
      if (!args["--force"]) {
        throw new Error(
          `Refusing to delete ${projectStorageDir(uid)} without --force (memory is not recoverable unless you exported it).`
        );
      }
      fs.rmSync(projectStorageDir(uid), { recursive: true, force: true });
      console.log(chalk.yellow(`Deleted ${projectStorageDir(uid)}`));
    }
    console.log(chalk.green(`✔ Forgot ${uid}`));
    return;
  }

  throw new Error(`Unknown project subcommand: ${subcommand}`);
}

interface LegacyProjectRow {
  id: string;
  uid?: string | null;
  name: string;
  git_remote: string | null;
  root_path: string;
}

interface MigrationReport {
  source: string;
  projects: number;
  observationsImported: number;
  observationsSkipped: number;
  entitiesImported: number;
  entitiesReused: number;
  linksImported: number;
  dependenciesImported: number;
  dryRun: boolean;
}

function findLegacyDatabases(scanRoot: string): string[] {
  const found: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Legacy storage is inspected, never walked as a normal directory.
        if (entry.name === ".huginn") {
          const candidate = path.join(dir, entry.name, "muninn.db");
          if (fs.existsSync(candidate)) found.push(candidate);
          continue;
        }
        if (SCAN_SKIP.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  walk(path.resolve(scanRoot), 0);
  return found;
}

function migrateOne(sourcePath: string, dryRun: boolean): MigrationReport {
  const report: MigrationReport = {
    source: sourcePath,
    projects: 0,
    observationsImported: 0,
    observationsSkipped: 0,
    entitiesImported: 0,
    entitiesReused: 0,
    linksImported: 0,
    dependenciesImported: 0,
    dryRun,
  };
  if (!fs.existsSync(sourcePath)) return report;

  const legacy = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const legacyProjects = legacy
      .prepare<[], LegacyProjectRow>(
        "SELECT id, name, git_remote, root_path FROM projects ORDER BY created_at ASC"
      )
      .all();

    const observationColumns = new Set(
      legacy
        .prepare<[], { name: string }>("PRAGMA table_info(observations)")
        .all()
        .map((column) => column.name)
    );
    const hasStatus = observationColumns.has("status");
    const hasSupersededBy = observationColumns.has("superseded_by");

    for (const legacyProject of legacyProjects) {
      const context = resolveProjectContext({ explicitRoot: legacyProject.root_path });
      report.projects += 1;

      if (dryRun) {
        const observations = legacy
          .prepare<[string], { n: number }>(
            "SELECT count(*) AS n FROM observations WHERE project_id = ?"
          )
          .get(legacyProject.id);
        report.observationsImported += observations?.n ?? 0;
        continue;
      }

      const target = getDatabase(undefined, context.rootPath);
      try {
        const project = ensureProject(target, {
          rootPath: context.rootPath,
          uid: context.uid,
          kind: context.kind,
          gitRemote: legacyProject.git_remote ?? context.gitRemote ?? undefined,
          name: legacyProject.name || context.name,
        });
        registerProjectContext({ ...context, uid: project.uid ?? context.uid, name: project.name });

        const selectObservations = hasStatus && hasSupersededBy
          ? legacy.prepare<[string], Record<string, unknown>>(
              `SELECT id, category, title, content, topic_key, status, superseded_by, created_at, updated_at
               FROM observations WHERE project_id = ? ORDER BY created_at ASC`
            )
          : legacy.prepare<[string], Record<string, unknown>>(
              `SELECT id, category, title, content, topic_key, created_at, updated_at
               FROM observations WHERE project_id = ? ORDER BY created_at ASC`
            );

        const insertObservation = target.prepare(
          `INSERT OR IGNORE INTO observations
             (id, project_id, category, title, content, topic_key, status, superseded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        const observations = selectObservations.all(legacyProject.id);
        for (const observation of observations) {
          const result = insertObservation.run(
            observation.id as string,
            project.id,
            observation.category as string,
            observation.title as string,
            observation.content as string,
            (observation.topic_key as string | null) ?? null,
            (observation.status as string | undefined) ?? "active",
            (observation.superseded_by as string | null | undefined) ?? null,
            (observation.created_at as string | undefined) ?? null,
            (observation.updated_at as string | undefined) ?? null
          );
          if (result.changes > 0) report.observationsImported += 1;
          else report.observationsSkipped += 1;
        }

        const findEntityByIdentifier = target.prepare<[string, string], { id: string }>(
          "SELECT id FROM entities WHERE project_id = ? AND identifier = ?"
        );
        const insertEntity = target.prepare(
          "INSERT OR IGNORE INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
        );
        const findEntityById = target.prepare<[string], { id: string }>(
          "SELECT id FROM entities WHERE id = ?"
        );
        const legacyEntities = legacy
          .prepare<[string], { id: string; entity_type: string; identifier: string; file_path: string }>(
            "SELECT id, entity_type, identifier, file_path FROM entities WHERE project_id = ?"
          )
          .all(legacyProject.id);
        const entityMap = new Map<string, string>();
        for (const entity of legacyEntities) {
          const byIdentifier = findEntityByIdentifier.get(project.id, entity.identifier);
          if (byIdentifier) {
            entityMap.set(entity.id, byIdentifier.id);
            report.entitiesReused += 1;
            continue;
          }
          const existingById = findEntityById.get(entity.id);
          if (existingById) {
            entityMap.set(entity.id, existingById.id);
            report.entitiesReused += 1;
            continue;
          }
          insertEntity.run(
            entity.id,
            project.id,
            entity.entity_type,
            entity.identifier,
            entity.file_path
          );
          entityMap.set(entity.id, entity.id);
          report.entitiesImported += 1;
        }

        const insertLink = target.prepare(
          "INSERT OR IGNORE INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
        );
        const legacyLinks = legacy
          .prepare<[string], { observation_id: string; entity_id: string }>(
            `SELECT oe.observation_id, oe.entity_id
             FROM observation_entities oe
             JOIN observations o ON o.id = oe.observation_id
             WHERE o.project_id = ?`
          )
          .all(legacyProject.id);
        for (const link of legacyLinks) {
          const mapped = entityMap.get(link.entity_id);
          if (!mapped) continue;
          const result = insertLink.run(link.observation_id, mapped);
          if (result.changes > 0) report.linksImported += 1;
        }

        const insertDependency = target.prepare(
          "INSERT OR IGNORE INTO entity_dependencies (source_entity_id, target_entity_id, relation_type) VALUES (?, ?, ?)"
        );
        const legacyDependencies = legacy
          .prepare<[string], { source_entity_id: string; target_entity_id: string; relation_type: string }>(
            `SELECT d.source_entity_id, d.target_entity_id, d.relation_type
             FROM entity_dependencies d
             JOIN entities e ON e.id = d.source_entity_id
             WHERE e.project_id = ?`
          )
          .all(legacyProject.id);
        for (const dependency of legacyDependencies) {
          const source = entityMap.get(dependency.source_entity_id);
          const targetEntity = entityMap.get(dependency.target_entity_id);
          if (!source || !targetEntity) continue;
          const result = insertDependency.run(source, targetEntity, dependency.relation_type);
          if (result.changes > 0) report.dependenciesImported += 1;
        }
      } finally {
        target.close();
      }
    }
  } finally {
    legacy.close();
  }
  return report;
}

export async function handleMigrateCommand(
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printMigrateUsage();
    return;
  }
  const dryRun = Boolean(args["--dry-run"]);
  const json = Boolean(args["--json"]);
  const sources: string[] = [];
  if (typeof args["--from"] === "string") {
    sources.push(path.resolve(args["--from"]));
  }
  if (typeof args["--scan"] === "string") {
    sources.push(...findLegacyDatabases(args["--scan"]));
  }
  if (sources.length === 0) {
    const projectRoot = resolveProjectContext({ startDir: process.cwd() }).rootPath;
    const candidates = [legacyProjectDbPath(projectRoot), legacyHomeDbPath()];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) sources.push(candidate);
    }
    if (typeof args["--project"] === "string") {
      const explicit = legacyProjectDbPath(args["--project"]);
      if (fs.existsSync(explicit)) sources.push(explicit);
    }
  }

  const uniqueSources = [...new Set(sources)];
  if (uniqueSources.length === 0) {
    console.log(
      "No legacy databases found. Pass --from <db> or --scan <dir> to point at one."
    );
    return;
  }

  const reports: MigrationReport[] = [];
  for (const source of uniqueSources) {
    reports.push(migrateOne(source, dryRun));
  }

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  for (const report of reports) {
    const prefix = report.dryRun ? chalk.yellow("Would migrate") : chalk.green("✔ Migrated");
    console.log(`${prefix} ${report.source}`);
    console.log(
      `  projects: ${report.projects}, observations: ${report.observationsImported} imported / ${report.observationsSkipped} already present`
    );
    console.log(
      `  entities: ${report.entitiesImported} imported / ${report.entitiesReused} reused, links: ${report.linksImported}, dependencies: ${report.dependenciesImported}`
    );
  }
  if (dryRun) {
    console.log(chalk.dim("\nDry run: nothing was written."));
  } else {
    console.log(
      chalk.dim(
        "\nLegacy databases were left untouched. Verify with `muninn project list` and `muninn memory brief --project <path>`."
      )
    );
  }
}

// Re-exported for tests and embedders that only import this module.
export { findLegacyDatabases, migrateOne, describeProject };
