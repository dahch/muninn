import path from "node:path";
import chalk from "chalk";
import { verifyTypeScriptContracts } from "../contracts/compiler.js";

export function printCheckUsage(): void {
  console.log(`muninn check — Static TypeScript execution contract verification

Usage:
  muninn check [files...] [--project <path>]

Options:
  --project <path>  Target project root containing tsconfig.json (default: cwd)
`);
}

export async function handleCheckCommand(
  files: string[],
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printCheckUsage();
    return;
  }

  const projectRoot =
    typeof args["--project"] === "string"
      ? path.resolve(args["--project"])
      : typeof args["--root"] === "string"
        ? path.resolve(args["--root"])
        : process.cwd();

  const targetFiles = files.length > 0 ? files : undefined;
  const result = verifyTypeScriptContracts(projectRoot, targetFiles);

  if (result.valid) {
    console.log(
      chalk.green(
        `✔ TypeScript contracts verified: 0 errors (${result.diagnostics.length} diagnostic(s)).`
      )
    );
    if (result.diagnostics.length > 0) {
      console.log(chalk.yellow("\nDiagnostics:"));
      for (const d of result.diagnostics) {
        const loc = chalk.dim(`${d.filePath}:${d.line}:${d.character}`);
        const code = chalk.yellow(`[${d.code}]`);
        const category = chalk.yellow(d.category.toUpperCase());
        console.log(`- ${loc} ${code} ${category}: ${d.message}`);
        if (d.snippet) {
          console.log(chalk.dim(d.snippet) + "\n");
        }
      }
    }
    return;
  }

  console.error(
    chalk.red.bold(
      `✖ TypeScript contracts check failed with ${result.errorsCount} error(s):\n`
    )
  );

  for (const d of result.diagnostics) {
    const loc = chalk.cyan(`${d.filePath}:${d.line}:${d.character}`);
    const code = chalk.yellow(`[${d.code}]`);
    const category =
      d.category === "error"
        ? chalk.red("ERROR")
        : chalk.yellow(d.category.toUpperCase());
    console.error(`- ${loc} ${code} ${category}: ${d.message}`);
    if (d.snippet) {
      console.error(chalk.dim(d.snippet) + "\n");
    }
  }

  process.exitCode = 1;
}
