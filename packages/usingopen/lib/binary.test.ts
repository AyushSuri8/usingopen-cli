import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChecksumMismatchError, downloadBinary, ensureBinary, releaseChannels } from "./binary.js";

const PAYLOAD = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("usingopen test payload")]);
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");
const STALE_DIGEST = "0".repeat(64);
const TAG = "v-test";

let cacheRoot;
let originalFetch;
let originalCacheHome;
let originalTag;
let checksumCalls;
let staleChecksums;

beforeEach(async () => {
	cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usingopen-launcher-test-"));
	originalCacheHome = process.env.XDG_CACHE_HOME;
	originalTag = process.env.USINGOPEN_RELEASE_TAG;
	originalFetch = globalThis.fetch;
	process.env.XDG_CACHE_HOME = cacheRoot;
	process.env.USINGOPEN_RELEASE_TAG = TAG;
	checksumCalls = [];
	staleChecksums = false;
	const asset = releaseChannels()[0].asset;

	globalThis.fetch = async input => {
		const url = String(input);
		if (url.includes("/SHA256SUMS.txt")) {
			checksumCalls.push(url);
			const digest = staleChecksums && !url.includes("?cb=") ? STALE_DIGEST : DIGEST;
			return new Response(`${digest}  ${asset}\n`);
		}
		if (url.endsWith(`/${asset}`)) {
			return new Response(PAYLOAD, { headers: { "content-length": String(PAYLOAD.length) } });
		}
		return new Response("not found", { status: 404 });
	};
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = originalCacheHome;
	if (originalTag === undefined) delete process.env.USINGOPEN_RELEASE_TAG;
	else process.env.USINGOPEN_RELEASE_TAG = originalTag;
	await fs.rm(cacheRoot, { recursive: true, force: true });
});

describe("launcher checksum verification", () => {
	it("retries with fresh checksums when the CDN serves a stale manifest", async () => {
		staleChecksums = true;
		const [channel] = releaseChannels();
		const destination = await downloadBinary(channel.base, TAG, channel.asset);
		expect(await fs.readFile(destination)).toEqual(PAYLOAD);
		expect(checksumCalls).toHaveLength(2);
		expect(checksumCalls[1]).toContain("?cb=");
	});

	it("fails closed on a persistent mismatch instead of falling back to upstream", async () => {
		globalThis.fetch = async input => {
			const url = String(input);
			if (url.includes("/SHA256SUMS.txt")) return new Response(`${STALE_DIGEST}  ${releaseChannels()[0].asset}\n`);
			if (url.endsWith(`/${releaseChannels()[0].asset}`)) {
				return new Response(PAYLOAD, { headers: { "content-length": String(PAYLOAD.length) } });
			}
			return new Response("not found", { status: 404 });
		};
		await expect(ensureBinary()).rejects.toBeInstanceOf(ChecksumMismatchError);
	});
});
