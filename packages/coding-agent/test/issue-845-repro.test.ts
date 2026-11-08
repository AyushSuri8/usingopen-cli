import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveUpdateMethodForTest } from "@usingopen/coding-agent/cli/update-cli";
import { removeSyncWithRetries } from "@usingopen/utils";

// Issue #845: on Windows with Bun installed via Scoop, ~/.bun is a junction
// to scoop\persist\Oven-sh.Bun\.bun. `bun pm bin -g` and the usingopen path that
// $which finds may end up referring to the same directory through different
// path strings (one through the junction, one through the real target).
// `isPathInDirectory` did purely lexical comparison via path.resolve, which
// does not follow filesystem links, so it misclassified Bun-installed usingopen
// as "binary" and tried to swap usingopen.exe in place – which fails on Windows
// because Bun has the file open (EPERM on unlink of .bak).
//
// We reproduce the realpath-resolution bug with a symlink (works on macOS /
// Linux; the bug is realpath, not junction-specific).

describe("issue-845: resolveUpdateMethod follows symlinks/junctions", () => {
	let tmpRoot: string;
	let realBinDir: string;
	let linkedBinDir: string;
	let usingopenPathViaLink: string;

	beforeAll(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usingopen-issue-845-"));
		realBinDir = path.join(tmpRoot, "real", "bin");
		fs.mkdirSync(realBinDir, { recursive: true });
		fs.writeFileSync(path.join(realBinDir, "usingopen"), "#!/bin/sh\n", { mode: 0o755 });

		linkedBinDir = path.join(tmpRoot, "link-bin");
		fs.symlinkSync(realBinDir, linkedBinDir, "dir");
		usingopenPathViaLink = path.join(linkedBinDir, "usingopen");
	});

	afterAll(() => {
		removeSyncWithRetries(tmpRoot);
	});

	it("classifies usingopen reached through a symlinked bin dir as bun-managed", () => {
		// $which resolves through the symlink, `bun pm bin -g` returns the real path
		// (or vice versa). Either direction must be recognized.
		const method = resolveUpdateMethodForTest(usingopenPathViaLink, realBinDir);
		expect(method).toBe("bun");
	});

	it("classifies usingopen at the real bin dir as bun-managed when bunBinDir is symlinked", () => {
		const usingopenAtReal = path.join(realBinDir, "usingopen");
		const method = resolveUpdateMethodForTest(usingopenAtReal, linkedBinDir);
		expect(method).toBe("bun");
	});
});
