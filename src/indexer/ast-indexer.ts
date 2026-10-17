import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import ts from "typescript";
import type {
  EntityType,
  DependencyRelationType,
  Entity,
} from "../db/client.js";
import type { IMemoryService } from "../service/memory-service.js";

export interface ExtractedDependency {
  sourceIdentifier: string;
  targetIdentifier: string;
  relationType: DependencyRelationType;
}

export interface ExtractedSymbol {
  name: string;
  identifier: string; // canonical identifier: <relPath>::<symbolName> or <relPath>::<ClassName>.<methodName>
  filePath: string;
  entityType: EntityType;
  startLine: number;
  endLine: number;
  isExported: boolean;
  dependencies?: ExtractedDependency[];
}

export interface AstExtractionResult {
  filePath: string;
  symbols: ExtractedSymbol[];
  dependencies: ExtractedDependency[];
}

export interface IndexSummary {
  indexedFiles: number;
  indexedSymbols: number;
  indexedDependencies: number;
}

/**
 * Normalizes file path to forward slashes.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Normalizes relative module specifiers against the importing file's directory.
 * Maps .js, .mjs, .cjs to .ts, and .jsx to .tsx, while keeping extensionless specifiers bare.
 */
export function normalizeModuleSpecifier(
  filePath: string,
  specifier: string
): string {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  const fileDir = path.dirname(filePath);
  let resolved = normalizePath(path.join(fileDir, specifier));

  if (resolved.endsWith(".js")) {
    resolved = resolved.slice(0, -3) + ".ts";
  } else if (resolved.endsWith(".mjs")) {
    resolved = resolved.slice(0, -4) + ".ts";
  } else if (resolved.endsWith(".cjs")) {
    resolved = resolved.slice(0, -4) + ".ts";
  } else if (resolved.endsWith(".jsx")) {
    resolved = resolved.slice(0, -4) + ".tsx";
  }
  return resolved;
}

/**
 * Extracts symbols and dependencies from TypeScript / JavaScript source code.
 */
export function extractSymbolsFromSource(
  filePath: string,
  sourceText: string
): ExtractedSymbol[] {
  const result = extractAstData(filePath, sourceText);
  return result.symbols;
}

/**
 * Comprehensive AST traversal returning both symbols and inter-symbol dependencies.
 */
export function extractAstData(
  filePath: string,
  sourceText: string
): AstExtractionResult {
  const normalizedFilePath = normalizePath(filePath);
  const sourceFile = ts.createSourceFile(
    normalizedFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    false // REV-010: setParentNodes = false for low memory and high performance
  );

  const symbols: ExtractedSymbol[] = [];
  const dependencies: ExtractedDependency[] = [];

  function getLine(pos: number): number {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  function isNodeExported(node: ts.Node): boolean {
    const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
    if ((flags & ts.ModifierFlags.Export) !== 0) {
      return true;
    }
    if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node);
      return Boolean(
        modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      );
    }
    return false;
  }

  // 1. Traverse top-level nodes for declarations and imports
  ts.forEachChild(sourceFile, (node) => {
    // Import declarations
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const rawSpecifier = node.moduleSpecifier.text;
        const specifier = normalizeModuleSpecifier(
          normalizedFilePath,
          rawSpecifier
        );
        dependencies.push({
          sourceIdentifier: normalizedFilePath,
          targetIdentifier: specifier,
          relationType: "imports",
        });

        // Also record named imports
        if (
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const spec of node.importClause.namedBindings.elements) {
            dependencies.push({
              sourceIdentifier: normalizedFilePath,
              targetIdentifier: `${specifier}::${spec.name.text}`,
              relationType: "imports",
            });
          }
        }
      }
      return;
    }

    // Export declarations with module specifiers: export { x } from './foo.js'
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const rawSpecifier = node.moduleSpecifier.text;
      const specifier = normalizeModuleSpecifier(
        normalizedFilePath,
        rawSpecifier
      );
      dependencies.push({
        sourceIdentifier: normalizedFilePath,
        targetIdentifier: specifier,
        relationType: "imports",
      });

      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          dependencies.push({
            sourceIdentifier: normalizedFilePath,
            targetIdentifier: `${specifier}::${spec.name.text}`,
            relationType: "imports",
          });
        }
      }
      return;
    }

    // Top-level or exported function declarations
    if (ts.isFunctionDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name)) {
        const name = node.name.text;
        const identifier = `${normalizedFilePath}::${name}`;
        const isExported = isNodeExported(node);
        symbols.push({
          name,
          identifier,
          filePath: normalizedFilePath,
          entityType: "function",
          startLine: getLine(node.getStart(sourceFile)),
          endLine: getLine(node.getEnd()),
          isExported,
        });
      }
      return;
    }

    // Exported variable statements (arrow functions or function expressions)
    if (ts.isVariableStatement(node)) {
      const isExported = isNodeExported(node);
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer))
        ) {
          const name = decl.name.text;
          const identifier = `${normalizedFilePath}::${name}`;
          symbols.push({
            name,
            identifier,
            filePath: normalizedFilePath,
            entityType: "function",
            startLine: getLine(decl.getStart(sourceFile)),
            endLine: getLine(decl.getEnd()),
            isExported,
          });
        }
      }
      return;
    }

    // Class declarations
    if (ts.isClassDeclaration(node)) {
      const className = node.name ? node.name.text : "AnonymousClass";
      const classIdentifier = `${normalizedFilePath}::${className}`;
      const isExported = isNodeExported(node);

      symbols.push({
        name: className,
        identifier: classIdentifier,
        filePath: normalizedFilePath,
        entityType: "class",
        startLine: getLine(node.getStart(sourceFile)),
        endLine: getLine(node.getEnd()),
        isExported,
      });

      // Class heritage clauses: extends and implements
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            for (const typeNode of clause.types) {
              const target = typeNode.expression.getText(sourceFile);
              dependencies.push({
                sourceIdentifier: classIdentifier,
                targetIdentifier: target,
                relationType: "extends",
              });
            }
          } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
            for (const typeNode of clause.types) {
              const target = typeNode.expression.getText(sourceFile);
              dependencies.push({
                sourceIdentifier: classIdentifier,
                targetIdentifier: target,
                relationType: "implements",
              });
            }
          }
        }
      }

      // Public class methods
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member)) {
          if (member.name && ts.isIdentifier(member.name)) {
            const methodName = member.name.text;

            // Check access modifiers: skip private / protected methods
            const isPrivate = member.modifiers?.some(
              (m) =>
                m.kind === ts.SyntaxKind.PrivateKeyword ||
                m.kind === ts.SyntaxKind.ProtectedKeyword
            );
            if (!isPrivate && !methodName.startsWith("#")) {
              const methodIdentifier = `${normalizedFilePath}::${className}.${methodName}`;
              symbols.push({
                name: `${className}.${methodName}`,
                identifier: methodIdentifier,
                filePath: normalizedFilePath,
                entityType: "function",
                startLine: getLine(member.getStart(sourceFile)),
                endLine: getLine(member.getEnd()),
                isExported,
              });
            }
          }
        }
      }
      return;
    }

    // Interface declarations
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const identifier = `${normalizedFilePath}::${name}`;
      const isExported = isNodeExported(node);

      symbols.push({
        name,
        identifier,
        filePath: normalizedFilePath,
        entityType: "interface",
        startLine: getLine(node.getStart(sourceFile)),
        endLine: getLine(node.getEnd()),
        isExported,
      });

      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            for (const typeNode of clause.types) {
              const target = typeNode.expression.getText(sourceFile);
              dependencies.push({
                sourceIdentifier: identifier,
                targetIdentifier: target,
                relationType: "extends",
              });
            }
          }
        }
      }
      return;
    }

    // Type Alias declarations
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const identifier = `${normalizedFilePath}::${name}`;
      const isExported = isNodeExported(node);

      symbols.push({
        name,
        identifier,
        filePath: normalizedFilePath,
        entityType: "interface",
        startLine: getLine(node.getStart(sourceFile)),
        endLine: getLine(node.getEnd()),
        isExported,
      });
      return;
    }
  });

  return {
    filePath: normalizedFilePath,
    symbols,
    dependencies,
  };
}

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

interface ParsedFile {
  relPath: string;
  ast: AstExtractionResult;
}

/**
 * Indexes a collection of files into Muninn's entities and entity_dependencies tables.
 *
 * Execution is cleanly separated into two stages (REV-001):
 * 1. Synchronous file reading, filtering, validation, and AST parsing are performed in-memory outside any database transaction.
 * 2. SQLite batch operations are executed inside a short-lived transaction with zombie entity pruning (REV-003, SEC-003).
 */
export function indexFilesIntoMuninn(
  memoryService: IMemoryService,
  filePaths: string[],
  options?: { projectRoot?: string }
): IndexSummary {
  const db = memoryService.db;
  const project = memoryService.currentProject;
  const projectRoot = options?.projectRoot ?? project.root_path;

  // Step 1: Read files and parse AST in-memory outside the database transaction (REV-001)
  const parsedFiles: ParsedFile[] = [];
  const seenPaths = new Set<string>();

  for (const rawFilePath of filePaths) {
    try {
      // Path Traversal Containment (SEC-001)
      const absolutePath = path.resolve(projectRoot, rawFilePath);
      const relPath = path.relative(projectRoot, absolutePath);
      if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
        continue;
      }

      // Filter by supported extensions
      const ext = path.extname(absolutePath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        continue;
      }

      // Check file exists, is regular file, and within max file size (2MB)
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }

      const normalizedRelPath = normalizePath(relPath);
      if (seenPaths.has(normalizedRelPath)) {
        continue;
      }
      seenPaths.add(normalizedRelPath);

      // Read content and parse AST
      const content = fs.readFileSync(absolutePath, "utf-8");
      const ast = extractAstData(normalizedRelPath, content);
      parsedFiles.push({
        relPath: normalizedRelPath,
        ast,
      });
    } catch {
      // Individual file read / syntax errors don't abort other files (REV-007)
      continue;
    }
  }

  // Step 2: Open db.transaction() strictly for the SQLite database batch inserts/updates
  let totalFiles = 0;
  let totalSymbols = 0;
  let totalDependencies = 0;

  db.transaction(() => {
    const findEntityStmt = db.prepare<[string, string], Entity>(
      `SELECT id, project_id, entity_type, identifier, file_path
       FROM entities
       WHERE project_id = ? AND identifier = ?`
    );

    const insertEntityStmt = db.prepare(
      `INSERT INTO entities (id, project_id, entity_type, identifier, file_path)
       VALUES (?, ?, ?, ?, ?)`
    );

    const updateEntityStmt = db.prepare(
      `UPDATE entities
       SET entity_type = ?, file_path = ?
       WHERE id = ?`
    );

    const deleteEntityStmt = db.prepare(
      `DELETE FROM entities
       WHERE id = ?`
    );

    const getEntitiesForFileStmt = db.prepare<
      [string, string],
      { id: string; identifier: string }
    >(
      `SELECT id, identifier
       FROM entities
       WHERE project_id = ? AND file_path = ?`
    );

    const insertDepStmt = db.prepare(
      `INSERT OR IGNORE INTO entity_dependencies (source_entity_id, target_entity_id, relation_type)
       VALUES (?, ?, ?)`
    );

    const deleteOldDepsStmt = db.prepare(
      `DELETE FROM entity_dependencies
       WHERE source_entity_id = ?`
    );

    function getOrCreateEntity(
      identifier: string,
      entityType: EntityType,
      filePath: string,
      isAuthoritative: boolean = false
    ): Entity {
      let entity = findEntityStmt.get(project.id, identifier);
      if (entity) {
        if (
          isAuthoritative &&
          (entity.entity_type !== entityType || entity.file_path !== filePath)
        ) {
          updateEntityStmt.run(entityType, filePath, entity.id);
          entity.entity_type = entityType;
          entity.file_path = filePath;
        }
        return entity;
      }

      const entityId = crypto.randomUUID();
      insertEntityStmt.run(
        entityId,
        project.id,
        entityType,
        identifier,
        filePath
      );

      return {
        id: entityId,
        project_id: project.id,
        entity_type: entityType,
        identifier,
        file_path: filePath,
      };
    }

    for (const { relPath, ast } of parsedFiles) {
      totalFiles++;

      // 1. Ensure file entity itself exists
      const fileEntity = getOrCreateEntity(relPath, "file", relPath, true);

      // Clean existing outgoing dependencies for the file
      deleteOldDepsStmt.run(fileEntity.id);

      // 2. Collect active identifiers for this file (the file entity + all extracted symbols)
      const activeIdentifiers = new Set<string>();
      activeIdentifiers.add(relPath);
      for (const sym of ast.symbols) {
        activeIdentifiers.add(sym.identifier);
      }

      // 3. Prune zombie / ghost entities for this file (REV-003, SEC-003)
      // Any entity belonging to (project_id, file_path) whose identifier is NOT in activeIdentifiers is removed.
      // ON DELETE CASCADE automatically purges related rows in entity_dependencies and observation_entities.
      const existingFileEntities = getEntitiesForFileStmt.all(
        project.id,
        relPath
      );
      for (const existing of existingFileEntities) {
        if (!activeIdentifiers.has(existing.identifier)) {
          deleteEntityStmt.run(existing.id);
        }
      }

      // Map from identifier to entity id for this file
      const entityMap = new Map<string, string>();
      entityMap.set(relPath, fileEntity.id);

      for (const sym of ast.symbols) {
        totalSymbols++;
        const symbolEntity = getOrCreateEntity(
          sym.identifier,
          sym.entityType,
          sym.filePath,
          true
        );
        entityMap.set(sym.identifier, symbolEntity.id);

        // Clean existing outgoing dependencies for this symbol before re-populating
        deleteOldDepsStmt.run(symbolEntity.id);

        // Link symbol to file as a reference
        insertDepStmt.run(fileEntity.id, symbolEntity.id, "references");
        totalDependencies++;
      }

      // 4. Insert dependencies
      for (const dep of ast.dependencies) {
        const sourceId =
          entityMap.get(dep.sourceIdentifier) ??
          getOrCreateEntity(dep.sourceIdentifier, "file", relPath, false).id;

        let targetEntityType: EntityType = "module";
        let targetFilePath = dep.targetIdentifier;

        if (
          dep.relationType === "implements" ||
          dep.relationType === "extends"
        ) {
          targetEntityType = "interface";
        } else if (
          dep.targetIdentifier.endsWith(".ts") ||
          dep.targetIdentifier.endsWith(".tsx") ||
          dep.targetIdentifier.endsWith(".mts") ||
          dep.targetIdentifier.endsWith(".cts") ||
          dep.targetIdentifier.endsWith(".js") ||
          dep.targetIdentifier.endsWith(".jsx") ||
          dep.targetIdentifier.endsWith(".mjs") ||
          dep.targetIdentifier.endsWith(".cjs")
        ) {
          targetEntityType = "file";
        } else if (dep.targetIdentifier.includes("::")) {
          const [filePart] = dep.targetIdentifier.split("::");
          targetFilePath = filePart;
        }

        const targetEntity = getOrCreateEntity(
          dep.targetIdentifier,
          targetEntityType,
          targetFilePath,
          false
        );

        insertDepStmt.run(sourceId, targetEntity.id, dep.relationType);
        totalDependencies++;
      }
    }
  })();

  return {
    indexedFiles: totalFiles,
    indexedSymbols: totalSymbols,
    indexedDependencies: totalDependencies,
  };
}
