/**
 * Test isolation for portable storage.
 *
 * Every test file gets its own `MUNINN_HOME`, so `MemoryService` never writes a
 * database, marker registry or snapshot into the real `~/.muninn`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.MUNINN_HOME || !process.env.MUNINN_HOME.includes("muninn-home-")) {
  process.env.MUNINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-home-"));
}
