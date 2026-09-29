/**
 * Where the browser tools load their heavy dependencies (playwright-core, lighthouse,
 * @axe-core/playwright) from.
 *
 * By default they resolve from the tools' own directory, so `npm install` next to
 * `package.json` here is all a developer needs. `TOT_TOOLS_DEPS_FROM` points resolution at
 * another package (a `package.json` path or a directory) that already has them installed.
 */
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** @param {string | undefined} from */
export function resolveFrom(from) {
  if (!from) return new URL("../package.json", import.meta.url);
  if (existsSync(from) && statSync(from).isDirectory()) return join(from, "package.json");
  return from;
}

export const toolRequire = createRequire(resolveFrom(process.env.TOT_TOOLS_DEPS_FROM));
