import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MemoryService,
  SESSION_BRIEF_ALL_BUDGET,
  SESSION_BRIEF_RECENT_ACTIVITY_LIMIT,
  readSessionBrief,
} from "../src/service/memory-service.js";
import { handleHookCommand } from "../src/commands/hook.js";

/**
 * `muninn hook session-start` used to clamp any requested budget to 20,000 and
 * default to 4,000, so a large project's brief was silently shorter than the one
 * the shared renderer would return. These tests pin the shared resolver instead:
 * the hook either honors the request, or fails with the escape hatch in view.
 */
describe("muninn hook session-start budget", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "muninn-hook-budget-"))
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  function seed(count: number): void {
    const service = new MemoryService({ projectRoot: tempDir });
    try {
      for (let i = 1; i <= count; i += 1) {
        service.saveObservation({
          category: "discovery",
          title: `Bulk discovery ${i}`,
          content: `Payload number ${i} for the hook budget test.`,
        });
      }
    } finally {
      service.close();
    }
  }

  function capture() {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    return {
      log,
      error,
      output: () => log.mock.calls.map((call) => call.join(" ")).join("\n"),
      errors: () => error.mock.calls.map((call) => call.join(" ")).join("\n"),
    };
  }

  it("defaults to the shared 8,000-character budget", async () => {
    seed(3);
    const captured = capture();
    try {
      await handleHookCommand("session-start", { "--project": tempDir });
      expect(captured.output()).toBe(
        readSessionBrief({ projectRoot: tempDir }).markdown
      );
      expect(captured.error).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      captured.log.mockRestore();
      captured.error.mockRestore();
    }
  });

  it("rejects an oversized numeric budget instead of silently clamping it", async () => {
    seed(3);
    const captured = capture();
    try {
      process.exitCode = 0;
      await handleHookCommand("session-start", {
        "--project": tempDir,
        "--budget": "60000",
      });
      expect(process.exitCode).toBe(1);
      expect(captured.log).not.toHaveBeenCalled();
      expect(captured.errors()).toContain("--budget must be");
      expect(captured.errors()).toContain("no greater than 20000");
      expect(captured.errors()).toContain('"all"');
    } finally {
      captured.log.mockRestore();
      captured.error.mockRestore();
    }
  });

  it("prints the complete brief with --all or --budget all", async () => {
    const total = SESSION_BRIEF_RECENT_ACTIVITY_LIMIT + 5;
    seed(total);
    const expected = readSessionBrief({
      projectRoot: tempDir,
      budgetChars: SESSION_BRIEF_ALL_BUDGET,
    }).markdown;
    expect(expected).toContain(`Bulk discovery ${total}`);

    const captured = capture();
    try {
      await handleHookCommand("session-start", {
        "--project": tempDir,
        "--all": true,
      });
      const viaFlag = captured.output();
      expect(viaFlag).toBe(expected);

      captured.log.mockClear();
      await handleHookCommand("session-start", {
        "--project": tempDir,
        "--budget": "all",
      });
      expect(captured.output()).toBe(expected);
      expect(captured.error).not.toHaveBeenCalled();
    } finally {
      captured.log.mockRestore();
      captured.error.mockRestore();
    }
  });
});
