import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ADS_PROTO, DEFAULT_ADS_URL } from "@usingopen/wire";
import {
	AdsClient,
	getAdsClient,
	MAX_ADS_PER_SESSION,
	MIN_AD_INTERVAL_MS,
	parseAdFeed,
	resetAdsClientForTest,
} from "@usingopen/tui/ads/client";
import { adsBaseUrl, adsDir, adsEnabledByEnv } from "@usingopen/tui/ads/store";
import { HOUSE_ADS } from "@usingopen/tui/ads/house-ads";

/** Unique config-dir name per test file so state never touches the real home. */
const TEST_CONFIG_DIR = `.usingopen-ads-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let savedConfigDir: string | undefined;
let savedAdsUrl: string | undefined;
let savedAds: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
	savedConfigDir = process.env.USINGOPEN_CONFIG_DIR;
	savedAdsUrl = process.env.USINGOPEN_ADS_URL;
	savedAds = process.env.USINGOPEN_ADS;
	savedHome = process.env.HOME;
	process.env.USINGOPEN_CONFIG_DIR = TEST_CONFIG_DIR;
	delete process.env.USINGOPEN_ADS_URL;
	delete process.env.USINGOPEN_ADS;
	// The store resolves the config root through os.homedir(); on platforms
	// where that is not HOME, pin a temp home so the test stays hermetic.
	process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usingopen-ads-"));
	resetAdsClientForTest();
});

afterEach(() => {
	restore(process.env, "USINGOPEN_CONFIG_DIR", savedConfigDir);
	restore(process.env, "USINGOPEN_ADS_URL", savedAdsUrl);
	restore(process.env, "USINGOPEN_ADS", savedAds);
	restore(process.env, "HOME", savedHome);
	const home = process.env.HOME ?? "";
	fs.rmSync(path.join(home, TEST_CONFIG_DIR), { recursive: true, force: true });
	resetAdsClientForTest();
});

function restore(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
	if (value === undefined) delete env[key];
	else env[key] = value;
}

/** A valid two-ad feed document. */
function feed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		proto: ADS_PROTO,
		ads: [
			{ id: "n1", kind: "sponsored", title: "T1", body: "B1", sponsor: "Acme" },
			{ id: "n2", kind: "house", title: "T2", body: "B2" },
		],
		...overrides,
	};
}

/** Stub fetch returning `body` with status 200. */
function stubFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("parseAdFeed", () => {
	it("accepts a well-formed feed", () => {
		const parsed = parseAdFeed(feed());
		expect(parsed?.ads.map(ad => ad.id)).toEqual(["n1", "n2"]);
	});

	it("rejects a newer proto, a missing list, and an empty list", () => {
		expect(parseAdFeed(feed({ proto: ADS_PROTO + 1 }))).toBeNull();
		expect(parseAdFeed({ proto: ADS_PROTO })).toBeNull();
		expect(parseAdFeed({ proto: ADS_PROTO, ads: [] })).toBeNull();
	});

	it("drops malformed entries but keeps the rest", () => {
		const parsed = parseAdFeed(
			feed({
				ads: [
					{ id: "ok", kind: "house", title: "T", body: "B" },
					{ id: "bad-kind", kind: "banner", title: "T", body: "B" },
					{ id: "sponsored-no-sponsor", kind: "sponsored", title: "T", body: "B" },
					{ id: "too-long", kind: "house", title: "T", body: "x".repeat(500) },
					{ id: "", kind: "house", title: "T", body: "B" },
				],
			}),
		);
		expect(parsed?.ads.map(ad => ad.id)).toEqual(["ok"]);
	});

	it("rejects non-https urls", () => {
		const parsed = parseAdFeed({
			proto: ADS_PROTO,
			ads: [{ id: "u", kind: "house", title: "T", body: "B", url: "http://insecure.example" }],
		});
		expect(parsed?.ads[0]?.url).toBeUndefined();
	});
});

describe("store env handling", () => {
	it("treats 0/false/off/yes as the kill switch", () => {
		expect(adsEnabledByEnv({ USINGOPEN_ADS: "0" })).toBe(false);
		expect(adsEnabledByEnv({ USINGOPEN_ADS: "false" })).toBe(false);
		expect(adsEnabledByEnv({ USINGOPEN_ADS: "off" })).toBe(false);
		expect(adsEnabledByEnv({ USINGOPEN_ADS: "1" })).toBe(true);
		expect(adsEnabledByEnv({})).toBe(true);
	});

	it("overrides the ad base URL and strips trailing slashes", () => {
		expect(adsBaseUrl({ USINGOPEN_ADS_URL: "https://ads.internal.test/" })).toBe("https://ads.internal.test");
		expect(adsBaseUrl({ USINGOPEN_ADS_URL: "not a url" })).toBe(DEFAULT_ADS_URL);
		expect(adsBaseUrl({})).toBe(DEFAULT_ADS_URL);
	});

	it("places the ads dir under the config root", () => {
		expect(adsDir().endsWith(`${TEST_CONFIG_DIR}/ads`)).toBe(true);
	});
});

describe("AdsClient", () => {
	it("starts on house ads and selects one", () => {
		const client = new AdsClient();
		expect(client.source).toBe("house");
		const ad = client.select("welcome", 0.99);
		expect(ad).not.toBeNull();
		expect(HOUSE_ADS.some(house => house.id === ad?.id)).toBe(true);
	});

	it("honors the env kill switch", () => {
		process.env.USINGOPEN_ADS = "0";
		const client = new AdsClient();
		expect(client.select("welcome", 0.5)).toBeNull();
		expect(client.enabled).toBe(false);
	});

	it("caps ads per session and then returns null", () => {
		let t = 1_000_000;
		const client = new AdsClient(() => t);
		for (let i = 0; i < MAX_ADS_PER_SESSION; i++) {
			expect(client.select("footer", 0.1 * i)).not.toBeNull();
			t += MIN_AD_INTERVAL_MS + 1;
		}
		expect(client.select("footer", 0.5)).toBeNull();
	});

	it("enforces the minimum interval between surfaces", () => {
		let t = 1_000_000;
		const client = new AdsClient(() => t);
		expect(client.select("welcome", 0.5)).not.toBeNull();
		expect(client.select("footer", 0.5)).toBeNull();
		t += MIN_AD_INTERVAL_MS + 1;
		expect(client.select("footer", 0.5)).not.toBeNull();
	});

	it("never shows a dismissed ad again", async () => {
		const client = new AdsClient();
		const ad = client.select("welcome", 0.99);
		expect(ad).not.toBeNull();
		client.dismiss(ad?.id ?? "");
		// A fresh client (same disk state) must not offer the dismissed ad.
		const next = new AdsClient();
		expect(next.ads.some(candidate => candidate.id === ad?.id)).toBe(true); // list still contains it
		expect(next.select("welcome", 0.99)?.id).not.toBe(ad?.id); // but it is filtered out
	});

	it("refresh adopts a valid network feed and persists it", async () => {
		const client = new AdsClient();
		await client.refresh(stubFetch(feed()));
		expect(client.source).toBe("network");
		expect(client.ads.map(ad => ad.id)).toEqual(["n1", "n2"]);
		// A second client reads the disk cache without any fetch.
		const cached = new AdsClient();
		expect(cached.source).toBe("network");
	});

	it("refresh keeps house ads on a bad payload", async () => {
		const client = new AdsClient();
		await client.refresh(stubFetch({ nope: true }));
		expect(client.source).toBe("house");
	});

	it("refresh keeps house ads on a network error", async () => {
		const client = new AdsClient();
		await client.refresh((async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch);
		expect(client.source).toBe("house");
	});

	it("refresh sends only the install-id headers", async () => {
		const client = new AdsClient();
		let seen: Record<string, string> = {};
		await client.refresh((async (_input: string, init?: RequestInit) => {
			seen = (init?.headers ?? {}) as Record<string, string>;
			return new Response(JSON.stringify(feed()), { status: 200 });
		}) as unknown as typeof fetch);
		const names = Object.keys(seen).sort();
		expect(names).toEqual(["accept", "x-omp-install-id", "x-usingopen-install-id"]);
		expect(seen["x-usingopen-install-id"]).toBe(seen["x-omp-install-id"]);
	});

	it("session toggle overrides the env switch", () => {
		const client = new AdsClient();
		client.setSessionEnabled(false);
		expect(client.enabled).toBe(false);
		client.setSessionEnabled(true);
		expect(client.enabled).toBe(true);
	});

	it("statusAd latches a single selection", () => {
		const client = new AdsClient();
		const first = client.statusAd();
		expect(client.statusAd()).toBe(first);
	});

	it("getAdsClient returns a stable singleton", () => {
		expect(getAdsClient()).toBe(getAdsClient());
	});

	it("MIN_AD_INTERVAL_MS is exported for docs/tests", () => {
		expect(MIN_AD_INTERVAL_MS).toBeGreaterThan(0);
	});
});
