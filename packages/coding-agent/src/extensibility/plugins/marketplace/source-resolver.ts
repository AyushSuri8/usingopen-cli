/**
 * Source resolver for marketplace plugin entries.
 *
 * Resolves plugin sources to absolute local directory paths:
 *   - Relative string "./plugins/foo" → path within marketplace clone
 *   - { source: "url", url: "https://...git" } → git clone
 *   - { source: "github", repo: "owner/repo" } → git clone from GitHub
 *   - { source: "git-subdir", url: "...", path: "sub/dir" } → git clone + subdir
 *   - { source: "npm", package: "..." } → registry tarball download + extract
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@usingopen/natives/vcs";
import { isEnoent, pathIsWithin } from "@usingopen/utils";
import { extractArchive } from "@usingopen/utils/ar";

import type { MarketplaceCatalogMetadata, MarketplacePluginEntry, PluginSource, PluginSourceNpm } from "./types";

const GIT_CLONE_TIMEOUT_MS = 30 * 60 * 1000;

/** Registry used when an npm source does not name one. */
const NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";
const NPM_METADATA_TIMEOUT_MS = 60 * 1000;
const NPM_TARBALL_TIMEOUT_MS = 5 * 60 * 1000;
/** Tarball ceiling; plugins are code packages, not datasets. */
const NPM_TARBALL_MAX_BYTES = 64 * 1024 * 1024;
/** npm keeps these in sync with the registry's own name rules. */
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NPM_PACKAGE_NAME_MAX_LENGTH = 214;

/**
 * `version` is a published version or a dist-tag (`latest`, `next`). Ranges are
 * rejected: they would require resolving a selector against every published
 * version, and a marketplace install must be reproducible.
 */
const NPM_VERSION_SELECTOR_RE = /^[A-Za-z0-9._+-]+$/;

interface NpmPackument {
	"dist-tags"?: Record<string, string>;
	versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
}

export interface ResolveContext {
	/** Absolute path to the cloned/local marketplace directory. Required for relative sources. */
	marketplaceClonePath?: string;
	/** Catalog metadata — used for `pluginRoot` prepend. */
	catalogMetadata?: MarketplaceCatalogMetadata;
	/** Scratch directory for sources that require cloning or extraction. */
	tmpDir: string;
}

/**
 * Resolve a plugin source to an absolute local directory path.
 *
 * The resolved path is verified to exist on disk.
 */
export async function resolvePluginSource(
	entry: MarketplacePluginEntry,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	const { source } = entry;

	if (typeof source === "string") {
		return resolveRelativeSource(source, context);
	}

	return resolveObjectSource(source, context);
}

/**
 * Validate source constraints that can be checked without cloning or mutating files.
 */
export async function validatePluginSource(
	entry: MarketplacePluginEntry,
	context: Pick<ResolveContext, "marketplaceClonePath" | "catalogMetadata">,
): Promise<string | undefined> {
	const { source } = entry;
	if (typeof source === "string") {
		const resolved = resolveRelativeSourcePath(source, context);
		await verifyDirExists(resolved, `Plugin source directory does not exist: "${resolved}"`);
		return resolved;
	}

	switch (source.source) {
		case "url":
		case "github":
			return undefined;
		case "git-subdir": {
			const syntheticRoot = path.join(path.parse(process.cwd()).root, "usingopen-marketplace-validation");
			const resolved = path.resolve(syntheticRoot, source.path);
			if (!pathIsWithin(syntheticRoot, resolved)) {
				throw new Error(`git-subdir path "${source.path}" escapes the cloned repository`);
			}
			return undefined;
		}
		case "npm":
			// Purely syntactic checks: validation must not hit the network.
			normalizeNpmRegistry(source.registry);
			assertNpmPackageName(source.package);
			if (source.version !== undefined) assertNpmVersionSelector(source.version);
			return undefined;
		default: {
			const unknownSource: unknown = source;
			if (
				unknownSource &&
				typeof unknownSource === "object" &&
				"source" in unknownSource &&
				typeof unknownSource.source === "string"
			) {
				throw new Error(`Unknown plugin source type: "${unknownSource.source}"`);
			}
			throw new Error("Unknown plugin source type");
		}
	}
}

// ── Relative string source ("./plugins/foo") ────────────────────────

function resolveRelativeSourcePath(
	source: string,
	context: Pick<ResolveContext, "marketplaceClonePath" | "catalogMetadata">,
): string {
	if (!source.startsWith("./")) {
		throw new Error(`Relative plugin source paths must start with "./" — got: "${source}"`);
	}
	if (!context.marketplaceClonePath) {
		throw new Error(`Cannot resolve relative source "${source}": marketplaceClonePath is required`);
	}

	const pluginRoot = context.catalogMetadata?.pluginRoot;
	const relativePath = pluginRoot ? `./${path.join(pluginRoot, source.slice(2))}` : source;
	const resolved = path.resolve(context.marketplaceClonePath, relativePath);
	if (!pathIsWithin(context.marketplaceClonePath, resolved)) {
		throw new Error(
			`Plugin source "${source}" resolves outside marketplace root ("${context.marketplaceClonePath}")`,
		);
	}
	return resolved;
}

async function resolveRelativeSource(
	source: string,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	const resolved = resolveRelativeSourcePath(source, context);
	await verifyDirExists(resolved, `Plugin source directory does not exist: "${resolved}"`);
	return { dir: resolved };
}

// ── Object source variants ──────────────────────────────────────────

async function resolveObjectSource(
	source: Exclude<PluginSource, string>,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	switch (source.source) {
		case "url": {
			// { source: "url", url: "https://github.com/owner/repo.git" }
			// Despite the name, this is typically a git clone URL
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await vcs.clone(source.url, targetDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "github": {
			// { source: "github", repo: "owner/repo" }
			const url = `https://github.com/${source.repo}.git`;
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await vcs.clone(url, targetDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "git-subdir": {
			// { source: "git-subdir", url: "owner/repo" | "https://...", path: "plugins/foo" }
			const url =
				source.url.includes("://") || source.url.startsWith("git@")
					? source.url
					: `https://github.com/${source.url}.git`;
			const cloneDir = path.join(context.tmpDir, `plugin-repo-${crypto.randomUUID()}`);
			await vcs.clone(url, cloneDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});

			const subdirPath = path.resolve(cloneDir, source.path);
			if (!pathIsWithin(cloneDir, subdirPath)) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw new Error(`git-subdir path "${source.path}" escapes the cloned repository`);
			}
			try {
				await verifyDirExists(subdirPath, `git-subdir path "${source.path}" does not exist in cloned repository`);
			} catch (err) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw err;
			}
			return { dir: subdirPath, tempCloneRoot: cloneDir };
		}

		case "npm":
			return resolveNpmSource(source, context);

		default:
			throw new Error(`Unknown plugin source type: "${(source as { source: string }).source}"`);
	}
}

// ── npm package source ──────────────────────────────────────────────

/**
 * Download an npm package tarball, verify its integrity, and extract it so the
 * package root can be used as a plugin directory. The registry packument is the
 * source of truth for both the resolved version and the tarball URL, so a
 * dist-tag install pins to the concrete version the catalog asked for.
 */
async function resolveNpmSource(
	source: PluginSourceNpm,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	const registry = normalizeNpmRegistry(source.registry);
	const packument = await fetchNpmPackument(registry, source.package);
	const version = resolveNpmVersion(packument, source.package, source.version);
	const dist = packument.versions?.[version]?.dist;
	const tarballUrl = typeof dist?.tarball === "string" ? dist.tarball : "";
	if (!tarballUrl) {
		throw new Error(`npm package "${source.package}" version "${version}" has no tarball URL`);
	}

	const bytes = await downloadNpmTarball(tarballUrl, source.package, version);
	verifyNpmIntegrity(bytes, dist?.integrity, source.package, version);

	const extractDir = path.join(context.tmpDir, `plugin-npm-${crypto.randomUUID()}`);
	await extractArchive({ bytes, format: "tar.gz" }, extractDir);

	// npm tarballs always nest their contents under `package/`; a missing
	// directory means an unpacked layout, so use the extraction root itself.
	const packageDir = path.join(extractDir, "package");
	const hasPackageDir = await fs
		.stat(packageDir)
		.then(stat => stat.isDirectory())
		.catch(() => false);
	return { dir: hasPackageDir ? packageDir : extractDir, tempCloneRoot: extractDir };
}

function normalizeNpmRegistry(registry: string | undefined): string {
	if (registry === undefined) return NPM_DEFAULT_REGISTRY;
	let url: URL;
	try {
		url = new URL(registry);
	} catch {
		throw new Error(`Invalid npm registry URL: "${registry}"`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Invalid npm registry URL: "${registry}" (must be http or https)`);
	}
	return url.toString().replace(/\/+$/, "");
}

function assertNpmPackageName(name: string): void {
	if (name.length === 0 || name.length > NPM_PACKAGE_NAME_MAX_LENGTH || !NPM_PACKAGE_NAME_RE.test(name)) {
		throw new Error(`Invalid npm package name: "${name}"`);
	}
}

function assertNpmVersionSelector(version: string): void {
	if (!NPM_VERSION_SELECTOR_RE.test(version)) {
		throw new Error(
			`Invalid npm version selector: "${version}". Use an exact version or a dist-tag (e.g. "1.2.0", "latest").`,
		);
	}
}

/** Percent-encode the scope separator; the registry expects `@scope%2Fname`. */
function encodeNpmPackageName(name: string): string {
	return name.replace("/", "%2F");
}

async function fetchNpmPackument(registry: string, name: string): Promise<NpmPackument> {
	const url = `${registry}/${encodeNpmPackageName(name)}`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(NPM_METADATA_TIMEOUT_MS),
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to reach npm registry at ${registry} for "${name}": ${reason}`);
	}
	if (!response.ok) {
		throw new Error(`npm registry returned ${response.status} for "${name}" (${url})`);
	}
	try {
		return (await response.json()) as NpmPackument;
	} catch {
		throw new Error(`npm registry returned invalid JSON for "${name}" (${url})`);
	}
}

function resolveNpmVersion(packument: NpmPackument, name: string, selector: string | undefined): string {
	const versions = Object.keys(packument.versions ?? {});
	if (versions.length === 0) {
		throw new Error(`npm package "${name}" has no published versions`);
	}
	const wanted = selector ?? packument["dist-tags"]?.latest;
	if (!wanted) {
		throw new Error(`npm package "${name}" has no "latest" dist-tag; pin an explicit version`);
	}
	const version = Object.hasOwn(packument.versions ?? {}, wanted) ? wanted : packument["dist-tags"]?.[wanted];
	if (!version || !Object.hasOwn(packument.versions ?? {}, version)) {
		throw new Error(
			`npm package "${name}" has no version or dist-tag "${wanted}" (available: ${versions.slice(-5).join(", ")})`,
		);
	}
	return version;
}

async function downloadNpmTarball(url: string, name: string, version: string): Promise<Uint8Array> {
	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(NPM_TARBALL_TIMEOUT_MS) });
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to download npm tarball for "${name}@${version}": ${reason}`);
	}
	if (!response.ok) {
		throw new Error(`npm tarball download for "${name}@${version}" returned ${response.status}`);
	}
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (declaredLength > NPM_TARBALL_MAX_BYTES) {
		throw new Error(`npm tarball for "${name}@${version}" exceeds ${NPM_TARBALL_MAX_BYTES} bytes`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > NPM_TARBALL_MAX_BYTES) {
		throw new Error(`npm tarball for "${name}@${version}" exceeds ${NPM_TARBALL_MAX_BYTES} bytes`);
	}
	return bytes;
}

const SRI_ALGORITHMS = ["sha512", "sha384", "sha256", "sha1"] as const;

/** Verify the packument's Subresource Integrity string against the tarball bytes. */
function verifyNpmIntegrity(bytes: Uint8Array, integrity: string | undefined, name: string, version: string): void {
	if (!integrity) return;
	for (const token of integrity.trim().split(/\s+/)) {
		const separator = token.indexOf("-");
		if (separator <= 0) continue;
		const algorithm = token.slice(0, separator);
		const expected = token.slice(separator + 1);
		if (!(SRI_ALGORITHMS as readonly string[]).includes(algorithm)) continue;
		const actual = crypto.createHash(algorithm).update(bytes).digest("base64");
		if (actual !== expected) {
			throw new Error(`npm tarball for "${name}@${version}" failed ${algorithm} integrity verification`);
		}
		return;
	}
	throw new Error(`npm package "${name}@${version}" declares no supported integrity algorithm`);
}

// ── Helpers ─────────────────────────────────────────────────────────

async function verifyDirExists(dirPath: string, errorMessage: string): Promise<void> {
	try {
		const stat = await fs.stat(dirPath);
		if (!stat.isDirectory()) {
			throw new Error(errorMessage);
		}
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(errorMessage);
		}
		throw err;
	}
}
