// Resolves, downloads, and caches the release binary for this platform.
//
// This package ships no runtime of its own: the CLI is a Bun-compiled
// executable, and each release publishes bare per-platform binaries plus a
// `SHA256SUMS.txt`. Reusing that published contract is what lets an npm install
// work on a machine with nothing but Node.
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Release host. `<base>/latest` resolves to the newest `<base>/download/<tag>/`,
 * which serves `<asset>` and `SHA256SUMS.txt`. Override for mirrors.
 */
export const dlBase = (process.env.USINGOPEN_DL_BASE ?? "https://github.com/can1357/oh-my-pi/releases").replace(
	/\/+$/,
	"",
);

/** How long a resolved release tag is reused before the host is asked again. */
const TAG_TTL_MS = 6 * 60 * 60 * 1000;

/** Release asset name for a target, matching the published artifacts. */
export function binaryAsset({ platform, arch, libc }) {
	if (platform === "win32") return `omp-windows-${arch}.exe`;
	if (platform === "darwin") return `omp-darwin-${arch}`;
	return `omp-${libc === "musl" ? "linux-musl" : "linux"}-${arch}`;
}

export function binaryUrl(tag, asset) {
	return `${dlBase}/download/${tag}/${asset}`;
}

export function checksumsUrl(tag) {
	return `${dlBase}/download/${tag}/SHA256SUMS.txt`;
}

/** Digest for `asset` from a `sha256sum`-style manifest, or undefined. */
export function expectedChecksum(checksums, asset) {
	for (const line of checksums.split("\n")) {
		const [digest, ...rest] = line.trim().split(/\s+/);
		const name = rest.join(" ").replace(/^\*/, "");
		if (name === asset && /^[0-9a-f]{64}$/i.test(digest ?? "")) return digest.toLowerCase();
	}
	return undefined;
}

/** `<cache>/usingopen/bin/<tag>/<asset>`; `XDG_CACHE_HOME` is honoured. */
export function cachePath(tag, asset) {
	return path.join(cacheRoot(), "bin", tag, asset);
}

function cacheRoot() {
	return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "usingopen");
}

function normalizeTag(tag) {
	const trimmed = tag.trim().replace(/^refs\/tags\//, "");
	if (!trimmed) return undefined;
	return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function tagCachePath() {
	return path.join(cacheRoot(), "latest-tag.json");
}

async function readCachedTag() {
	try {
		const cached = JSON.parse(await fs.promises.readFile(tagCachePath(), "utf8"));
		const tag = typeof cached?.tag === "string" ? normalizeTag(cached.tag) : undefined;
		if (!tag) return undefined;
		return { tag, fresh: Date.now() - Number(cached.fetchedAt) < TAG_TTL_MS };
	} catch {
		return undefined;
	}
}

async function writeCachedTag(tag) {
	const file = tagCachePath();
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await fs.promises.writeFile(file, JSON.stringify({ tag, fetchedAt: Date.now() }));
}

/** Newest published release tag, reusing a cached answer for a few hours. */
export async function resolveTag(log = () => {}) {
	const pinned = process.env.USINGOPEN_RELEASE_TAG;
	if (pinned) return normalizeTag(pinned);

	const cached = await readCachedTag();
	if (cached?.fresh) return cached.tag;
	try {
		const tag = await fetchLatestTag();
		await writeCachedTag(tag);
		return tag;
	} catch (error) {
		if (cached?.tag) {
			log(`could not refresh the release list (${describe(error)}); using cached ${cached.tag}`);
			return cached.tag;
		}
		throw error;
	}
}

async function fetchLatestTag() {
	const latest = `${dlBase}/latest`;
	const head = await fetch(latest, { method: "HEAD", redirect: "manual" });
	const location = head.headers.get("location");
	// A GitHub-style host redirects to .../tag/<tag>; a plain-text mirror serves
	// the tag itself (what `scripts/install.sh` reads), hence the GET fallback.
	const fromRedirect = location?.match(/\/tag\/([^/?#]+)/)?.[1] ?? location?.match(/\/(v[^/?#]+)\/?$/)?.[1];
	if (fromRedirect) return normalizeTag(fromRedirect);
	if (head.ok) {
		const body = await fetch(latest).then(response => response.text());
		const fromBody = body.trim().split("\n")[0]?.trim();
		if (fromBody) return normalizeTag(fromBody);
	}
	throw new Error(`could not resolve the latest release from ${latest} (HTTP ${head.status})`);
}

function isMusl() {
	if (process.platform !== "linux") return false;
	const override = process.env.USINGOPEN_LIBC;
	if (override) return override === "musl";
	if (fs.existsSync("/etc/alpine-release")) return true;
	// Mirror the installer's probe: `ldd --version` reports the libc flavour.
	const probe = spawnSync("ldd", ["--version"], { encoding: "utf8" });
	return /musl/i.test(`${probe.stdout ?? ""}${probe.stderr ?? ""}`);
}

export function detectTarget() {
	const { platform, arch } = process;
	if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
		throw new Error(`unsupported platform: ${platform}`);
	}
	if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported architecture: ${arch}`);
	return { platform, arch, libc: isMusl() ? "musl" : "glibc" };
}

/**
 * True when `bytes` starts with an executable magic number (ELF, Mach-O thin or
 * fat, or PE). A captive portal or a misconfigured mirror answers 200 with an
 * error page; that must never reach the cache or be executed.
 */
export function looksExecutable(bytes) {
	if (bytes.length < 4) return false;
	if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true;
	if (bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
	const magic = bytes.readUInt32BE(0);
	return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

async function fetchChecksums(tag, asset) {
	for (const name of ["SHA256SUMS.txt", "SHA256SUMS"]) {
		try {
			const response = await fetch(`${dlBase}/download/${tag}/${name}`);
			if (!response.ok) continue;
			const digest = expectedChecksum(await response.text(), asset);
			if (digest) return digest;
		} catch {
			// Try the next manifest name; a host without checksums still installs.
		}
	}
	return undefined;
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

export async function downloadBinary(tag, asset, log = () => {}) {
	const destination = cachePath(tag, asset);
	await fs.promises.mkdir(path.dirname(destination), { recursive: true });
	const url = binaryUrl(tag, asset);
	log(`downloading ${asset} (${tag})…`);

	const response = await fetch(url);
	if (!response.ok) throw new Error(`download failed: ${url} returned HTTP ${response.status}`);
	if (!response.body) throw new Error(`download failed: ${url} returned an empty response`);
	if ((response.headers.get("content-type") ?? "").includes("text/html")) {
		throw new Error(`download failed: ${url} served an HTML page instead of ${asset}`);
	}

	// Stream to a staging file while hashing: the binary is a few hundred MiB and
	// buffering it whole costs more memory than an installer should ever use.
	const staging = `${destination}.${process.pid}.tmp`;
	const total = Number(response.headers.get("content-length") ?? 0);
	const hash = crypto.createHash("sha256");
	let head = Buffer.alloc(0);
	let received = 0;
	let milestone = 25;
	let expected;

	const meter = new Transform({
		transform(chunk, _encoding, callback) {
			hash.update(chunk);
			if (head.length < 8) head = Buffer.concat([head, chunk.subarray(0, 8 - head.length)]);
			received += chunk.length;
			if (total > 0 && (received / total) * 100 >= milestone) {
				log(`${asset}: ${milestone}%`);
				milestone += 25;
			}
			callback(null, chunk);
		},
	});

	try {
		await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(staging, { mode: 0o755 }));
		if (!looksExecutable(head)) {
			throw new Error(`download failed: ${asset} is not an executable (${received} bytes); check ${url}`);
		}
		const digest = hash.digest("hex");
		expected = await fetchChecksums(tag, asset);
		if (expected && expected !== digest) {
			throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${digest}`);
		}
		await fs.promises.chmod(staging, 0o755);
		// Rename last: an interrupted download never leaves a half-written binary
		// that the next run would happily execute.
		await fs.promises.rename(staging, destination);
	} catch (error) {
		await fs.promises.rm(staging, { force: true });
		throw error;
	}

	log(`installed ${asset} (${(received / 1024 / 1024).toFixed(1)} MiB)${expected ? ", checksum verified" : ""}`);
	return destination;
}

/** Cached release binary for this platform, downloading it when absent. */
export async function ensureBinary(log = () => {}) {
	const asset = binaryAsset(detectTarget());
	const tag = await resolveTag(log);
	const destination = cachePath(tag, asset);
	const existing = await fs.promises.stat(destination).catch(() => undefined);
	if (existing?.isFile()) return destination;
	return downloadBinary(tag, asset, log);
}
