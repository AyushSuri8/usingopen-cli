#!/usr/bin/env node
// `npm install -g usingopen` entry point: hand off to the release binary for
// this platform, fetching it once if the install-time prefetch was skipped
// (`--ignore-scripts`).
import { spawn } from "node:child_process";
import { ensureBinary } from "../lib/binary.js";

let binary;
try {
	binary = await ensureBinary(line => process.stderr.write(`usingopen: ${line}\n`));
} catch (error) {
	process.stderr.write(`usingopen: ${error instanceof Error ? error.message : String(error)}\n`);
	process.stderr.write(
		"No binary installed. Download one from https://github.com/AyushSuri8/usingopen-cli/releases, " +
			"or set USINGOPEN_DL_BASE to a mirror and retry.\n",
	);
	process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
// The CLI owns the terminal; forward signals rather than dying ahead of it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
