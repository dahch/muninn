import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { resetSessionCache } from "../src/project/session.js";

const roots: string[] = [];
const savedEnv = { ...process.env };

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muninn-" + prefix + "-")));
  roots.push(dir);
  return dir;
}

function writeSession(dshHome: string, id: string, cwd: string): void {
  const dir = path.join(dshHome, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session-" + id + ".json"),
    JSON.stringify({ record: { identity: { cwd } } })
  );
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

afterEach(() => {
  resetSessionCache();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("DSH workspace bootstrap", () => {
  it("follows the project pinned with muninn_project use instead of the server cwd", async () => {
    const workspace = tempDir("ws");
    const projectRoot = path.join(workspace, "repo-a");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "repo-b", ".git"), { recursive: true });
    const dshHome = tempDir("dsh");
    writeSession(dshHome, "current", workspace);
    process.env.DSH_HOME = dshHome;
    process.env.MUNINN_SESSION_AUTODETECT = "dsh";
    process.env.MUNINN_HOME = tempDir("home");
    resetSessionCache();

    const server = createMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "workspace-bootstrap", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      const guidance = textOf(await client.callTool({ name: "muninn_bootstrap", arguments: {} }));
      expect(guidance).toContain("# Session workspace:");
      expect(guidance).toContain(projectRoot);

      const used = await client.callTool({
        name: "muninn_project",
        arguments: { action: "use", path: projectRoot },
      });
      const usedPayload = JSON.parse(textOf(used)) as { project: { rootPath: string } };
      expect(usedPayload.project.rootPath).toBe(projectRoot);

      const brief = textOf(await client.callTool({ name: "muninn_bootstrap", arguments: {} }));
      expect(brief).toContain(projectRoot);
      expect(brief).not.toContain("# Session workspace:");
    } finally {
      await client.close();
      await server.close();
      server.closeService();
    }
  }, 60_000);
});
