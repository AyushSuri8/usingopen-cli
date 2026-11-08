import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MarketplacePluginEntry } from "@usingopen/coding-agent/extensibility/plugins/marketplace";
import { resolvePluginSource, validatePluginSource } from "@usingopen/coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@usingopen/utils";

// Fixture: a cloned marketplace with a single plugin at ./plugins/hello-plugin
const FIXTURE_DIR = path.resolve(import.meta.dir, "fixtures/valid-marketplace");

// Helper — build a minimal MarketplacePluginEntry with the given source
function makeEntry(source: MarketplacePluginEntry["source"]): MarketplacePluginEntry {
	return { name: "hello-plugin", source };
}

describe("resolvePluginSource", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usingopen-src-res-test-"));
	});

	afterEach(() => {
		removeSyncWithRetries(tmpDir);
	});

	it("resolves relative source to absolute plugin directory", async () => {
		const entry = makeEntry("./plugins/hello-plugin");
		const resolved = await resolvePluginSource(entry, {
			marketplaceClonePath: FIXTURE_DIR,
			tmpDir,
		});
		expect(resolved.dir).toBe(path.resolve(FIXTURE_DIR, "plugins/hello-plugin"));
		expect(resolved.tempCloneRoot).toBeUndefined();
	});

	it("validates relative sources without mutating or cloning", async () => {
		await expect(
			validatePluginSource(makeEntry("./plugins/hello-plugin"), { marketplaceClonePath: FIXTURE_DIR }),
		).resolves.toBe(path.resolve(FIXTURE_DIR, "plugins/hello-plugin"));
	});

	it("accepts a well-formed npm source during validation", async () => {
		await expect(
			validatePluginSource(makeEntry({ source: "npm", package: "@acme/usingopen-plugin", version: "1.2.0" }), {}),
		).resolves.toBeUndefined();
	});

	it("rejects npm sources with an invalid package name or version range during validation", async () => {
		await expect(validatePluginSource(makeEntry({ source: "npm", package: "../escape" }), {})).rejects.toThrow(
			/Invalid npm package name/,
		);
		await expect(
			validatePluginSource(makeEntry({ source: "npm", package: "hello-plugin", version: "^1.0.0" }), {}),
		).rejects.toThrow(/Invalid npm version selector/);
	});

	it("rejects git-subdir traversal during validation", async () => {
		await expect(
			validatePluginSource(makeEntry({ source: "git-subdir", url: "owner/repo", path: "../../escape" }), {}),
		).rejects.toThrow(/escapes the cloned repository/);
	});

	it("allows git-subdir parent segments that remain contained", async () => {
		await expect(
			validatePluginSource(
				makeEntry({ source: "git-subdir", url: "owner/repo", path: "packages/../plugins/foo" }),
				{},
			),
		).resolves.toBeUndefined();
	});

	it("throws when source string would escape marketplace root", async () => {
		// "../../escape" does not start with "./" — hits the non-relative guard
		const entry = makeEntry("../../escape");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow();
	});

	it("throws when relative source would escape via path traversal (./../../escape)", async () => {
		// Starts with "./" but resolves outside marketplace root
		const entry = makeEntry("./../../escape");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/outside marketplace root/,
		);
	});

	it("throws when marketplaceClonePath is missing for relative source", async () => {
		const entry = makeEntry("./plugins/hello-plugin");
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/marketplaceClonePath/);
	});

	it("prepends catalogMetadata.pluginRoot to the relative source path", async () => {
		// pluginRoot "plugins" + source "./hello-plugin" → ./plugins/hello-plugin
		const entry = makeEntry("./hello-plugin");
		const resolved = await resolvePluginSource(entry, {
			marketplaceClonePath: FIXTURE_DIR,
			catalogMetadata: { pluginRoot: "plugins" },
			tmpDir,
		});
		expect(resolved.dir).toBe(path.resolve(FIXTURE_DIR, "plugins/hello-plugin"));
		expect(resolved.tempCloneRoot).toBeUndefined();
	});

	it("throws when resolved directory does not exist", async () => {
		const entry = makeEntry("./plugins/nonexistent-plugin");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/does not exist/,
		);
	});

	describe("npm sources", () => {
		// A real tarball, served by a local registry so the resolver's download,
		// integrity check, and extraction paths all run without network access.
		const npmPackage = "@acme/usingopen-plugin";
		const npmVersion = "1.2.0";
		const tarballPromise = new Bun.Archive(
			{
				"package/package.json": JSON.stringify({ name: npmPackage, version: npmVersion }),
				"package/plugin.json": JSON.stringify({ name: "hello-plugin", version: npmVersion }),
			},
			{ compress: "gzip" },
		).bytes();
		let tarball: Uint8Array;
		let integrity: string;
		let packumentIntegrity: string;
		let server: ReturnType<typeof Bun.serve>;
		let registry: string;

		beforeAll(async () => {
			tarball = await tarballPromise;
			integrity = `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`;
			packumentIntegrity = integrity;
			server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch(request) {
					const url = new URL(request.url);
					if (url.pathname === "/@acme%2Fusingopen-plugin") {
						return Response.json({
							"dist-tags": { latest: npmVersion },
							versions: {
								[npmVersion]: {
									dist: {
										tarball: `${registry}/tarballs/usingopen-plugin-${npmVersion}.tgz`,
										integrity: packumentIntegrity,
									},
								},
							},
						});
					}
					if (url.pathname === `/tarballs/usingopen-plugin-${npmVersion}.tgz`) {
						return new Response(tarball);
					}
					return new Response("not found", { status: 404 });
				},
			});
			registry = `http://127.0.0.1:${server.port}`;
		});

		afterAll(() => {
			server.stop(true);
		});

		it("downloads, verifies, and extracts the package root", async () => {
			const resolved = await resolvePluginSource(
				makeEntry({ source: "npm", package: npmPackage, version: npmVersion, registry }),
				{ tmpDir },
			);

			expect(resolved.tempCloneRoot?.startsWith(tmpDir)).toBe(true);
			expect(resolved.dir).toBe(path.join(resolved.tempCloneRoot!, "package"));
			const manifest: { name?: string } = await Bun.file(path.join(resolved.dir, "package.json")).json();
			expect(manifest.name).toBe(npmPackage);
			expect(await Bun.file(path.join(resolved.dir, "plugin.json")).exists()).toBe(true);
		});

		it("resolves a dist-tag to the published version", async () => {
			const resolved = await resolvePluginSource(
				makeEntry({ source: "npm", package: npmPackage, version: "latest", registry }),
				{ tmpDir },
			);
			const manifest: { version?: string } = await Bun.file(path.join(resolved.dir, "package.json")).json();
			expect(manifest.version).toBe(npmVersion);
		});

		it("rejects a tarball whose bytes do not match the declared integrity", async () => {
			packumentIntegrity = `sha512-${Buffer.from("wrong").toString("base64")}`;
			try {
				await expect(
					resolvePluginSource(makeEntry({ source: "npm", package: npmPackage, registry }), { tmpDir }),
				).rejects.toThrow(/integrity verification/);
			} finally {
				packumentIntegrity = integrity;
			}
		});

		it("rejects versions the registry does not publish", async () => {
			await expect(
				resolvePluginSource(makeEntry({ source: "npm", package: npmPackage, version: "9.9.9", registry }), {
					tmpDir,
				}),
			).rejects.toThrow(/no version or dist-tag/);
		});
	});
});
