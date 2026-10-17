/**
 * H-1 — symlink-safe resolution of **document** paths (spec/adr/plan).
 *
 * A repository Muninn reads is attacker-controlled the moment it is not ours: a
 * clone can ship `spec.md -> ~/.aws/credentials`, `adr.md -> /etc/passwd` or a
 * `docs/` directory that points anywhere on the host. Both directions were open:
 *
 * - **read** — `readOptional`/`readFileBounded` followed the link, so the target's
 *   content was read and embedded in an agent prompt (an exfiltration channel
 *   straight out of the project), and
 * - **write** — `writeDoc` followed it too, so the drafting step *overwrote* the
 *   link target (a `~/.aws/credentials` clobbered by a generated `spec.md`).
 *
 * The rule enforced here is deliberately simple and fail-closed:
 *
 * 1. The final path component is `lstat`ed and a **symlink is always refused** —
 *    the link is never followed, read or overwritten. This holds for every caller,
 *    including the ones whose doc genuinely lives outside the project, because
 *    "an explicitly configured path" is a reason to allow the *file*, never a
 *    reason to let a repo swap it for a link to somewhere else.
 * 2. When the path is lexically **inside the project root** — the normal case, and
 *    the only one an attacker controls — the resolved path must stay inside the
 *    resolved project root as well: `realpath` resolves every component, so a
 *    symlinked *parent* (`docs/ -> /etc`) is caught too, and the containment test
 *    runs on the real paths so a project reached through a symlink (macOS
 *    `/var` → `/private/var`) is not mistaken for an escape.
 *
 * Legitimate out-of-project docs (`--spec /srv/shared/spec.md`) keep working: they
 * are only symlink-screened, exactly as the pre-existing behaviour but without the
 * link-following hole.
 *
 * A path that does not exist yet is accepted (plan mode drafts new documents):
 * the nearest existing ancestor is resolved and the missing tail is re-joined, so
 * containment is still decided on real paths.
 *
 * The same screen — it is a path rule, not a document rule — also guards the
 * **operational** paths a cloned repository can ship as links just as easily as a
 * document: the harness state, phase reports and progress page (SEC-102), the
 * iteration receipts (SEC-102), the server log (SEC-101) and the update cache
 * (SEC-105). Only the mechanism is reused: a symlink on the final component is
 * always refused, and a project-relative path must resolve inside the project.
 */
import { constants as fsConstants, lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * `O_NOFOLLOW` where the platform defines it, `0` elsewhere (Windows). Callers
 * that open a path they have just screened use it to close the check-then-open
 * window: a symlink swapped in between still cannot be followed.
 */
export const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

/** Outcome of {@link checkDocPath}. */
export type DocPathCheck = { ok: true; path: string } | { ok: false; reason: string };

export interface DocPathOptions {
  /**
   * Project root. When the path is lexically inside it, the *resolved* path must
   * be inside the resolved root too; when the path is outside, only the symlink
   * screen applies (an explicitly configured document must keep working).
   */
  projectPath?: string;
  /** Human label for the document, used in the error message (e.g. `spec doc`). */
  label?: string;
  /** What the caller is about to do, used in the error message (e.g. `write`). */
  action?: string;
}

/** True when `child` is strictly under `root` (both must be absolute, resolved paths). */
export function isInside(child: string, root: string): boolean {
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return child.startsWith(base);
}

/** `lstat` without treating "does not exist" as a failure. */
export function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * The path with every *existing* component `realpath`ed and the not-yet-existing
 * tail re-joined, so containment is decided on real paths even for a document
 * plan mode is about to create.
 *
 * The final component is not followed *as a link* by this function either: a
 * symlink there is already refused by {@link checkDocPath}, and the callers that
 * pass a resolved path do so only after that check.
 */
export function realpathAllowingMissing(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(current);
      // Walked up to the filesystem root without resolving anything (a mount
      // that cannot be realpath'ed): keep the (bounded) lexical answer rather
      // than looping. Containment then simply fails closed if it is required.
      if (parent === current) return join(current, ...tail);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Decide whether `path` may be read/written as a document (see the module
 * header). Returns the canonical path to use — every existing component
 * resolved, the final component untouched — or the reason it must be refused.
 *
 * On `ok: false` a caller must do *nothing* with the path: no read, no write.
 */
export function checkDocPath(path: string, opts: DocPathOptions = {}): DocPathCheck {
  const target = resolve(path);
  const label = opts.label ?? "document";
  const action = opts.action ?? "read or write";

  let stat: Stats | undefined;
  try {
    stat = lstatOrUndefined(target);
  } catch (err) {
    return { ok: false, reason: `cannot inspect ${label} ${target}: ${(err as Error).message}` };
  }
  if (stat?.isSymbolicLink()) {
    return {
      ok: false,
      reason:
        `${label} ${target} is a symlink; refusing to ${action} through it ` +
        `(a link shipped by the repository must never reach or clobber its target)`,
    };
  }

  const projectPath = opts.projectPath === undefined ? undefined : resolve(opts.projectPath);
  if (projectPath === undefined) return { ok: true, path: realpathAllowingMissing(target) };

  let realProject: string | undefined;
  try {
    realProject = realpathSync(projectPath);
  } catch {
    realProject = undefined;
  }

  // Containment is only demanded where it means something: a path that is *not*
  // inside the project was named explicitly by the user (`--spec /srv/…`) and may
  // legitimately live elsewhere. (A sandboxed cycle is the same shape: the docs
  // are read from the primary tree, not from the ephemeral worktree.)
  const insideLexically =
    (target !== projectPath && isInside(target, projectPath)) ||
    (realProject !== undefined && target !== realProject && isInside(target, realProject));
  if (!insideLexically) return { ok: true, path: realpathAllowingMissing(target) };

  if (realProject === undefined) {
    return {
      ok: false,
      reason: `cannot resolve the project root ${projectPath} to contain ${label} ${target}`,
    };
  }
  const realTarget = realpathAllowingMissing(target);
  if (!isInside(realTarget, realProject)) {
    return {
      ok: false,
      reason:
        `${label} ${target} resolves to ${realTarget}, outside the project root ${realProject}; ` +
        `refusing to ${action} it`,
    };
  }
  return { ok: true, path: realTarget };
}

/** {@link checkDocPath}, throwing on a refused path (fail-closed for writers). */
export function assertDocPath(path: string, opts: DocPathOptions = {}): string {
  const check = checkDocPath(path, opts);
  if (!check.ok) throw new Error(check.reason);
  return check.path;
}
