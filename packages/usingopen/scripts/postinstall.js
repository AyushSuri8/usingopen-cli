#!/usr/bin/env node
// Prefetch the release binary at install time so the first `usingopen` run does
// not stall on a download. Failures are warnings: `bin/usingopen.js` retries on
// demand, so a network blip never breaks `npm install -g usingopen`.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "../lib/binary.js";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// `bun install` at the repo root links this workspace beside `bun.lock`; only a
// real npm install should pay for the download.
if (fs.existsSync(path.join(packageDir, "..", "..", "bun.lock"))) process.exit(0);
if (process.env.USINGOPEN_SKIP_POSTINSTALL === "1") process.exit(0);

try {
	await ensureBinary(line => process.stdout.write(`usingopen: ${line}\n`));
} catch (error) {
	const reason = error instanceof Error ? error.message : String(error);
	process.stdout.write(`usingopen: binary prefetch failed (${reason}); the first run will retry.\n`);
}
