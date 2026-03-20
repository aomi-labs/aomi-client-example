/**
 * Links @aomi-labs/client to a local AOMI_WIDGET_ROOT.
 *
 * Usage:
 *   AOMI_WIDGET_ROOT=/path/to/aomi-widget node scripts/link-client.mjs
 *   node scripts/link-client.mjs --unlink
 *   pnpm install
 *
 * Without AOMI_WIDGET_ROOT, or with --unlink, resets to the published npm version.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";

const pkgPath = join(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const root = process.env.AOMI_WIDGET_ROOT;
const shouldUnlink = process.argv.includes("--unlink");
const publishedClientVersion = "^0.1.5";

if (!root || shouldUnlink) {
  if (pkg.dependencies["@aomi-labs/client"]?.startsWith("file:")) {
    pkg.dependencies["@aomi-labs/client"] = publishedClientVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`[link-client] Reset to published @aomi-labs/client ${publishedClientVersion}`);
  } else {
    console.log("[link-client] Already using published @aomi-labs/client");
  }
  process.exit(0);
}

const clientDir = resolve(root, "packages/client");
if (!existsSync(clientDir)) {
  console.error(`[link-client] ERROR: ${clientDir} does not exist`);
  process.exit(1);
}

const fileRef = `file:${clientDir}`;
if (pkg.dependencies["@aomi-labs/client"] === fileRef) {
  console.log(`[link-client] Already linked to ${clientDir}`);
  process.exit(0);
}

pkg.dependencies["@aomi-labs/client"] = fileRef;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`[link-client] Linked @aomi-labs/client → ${clientDir}`);
