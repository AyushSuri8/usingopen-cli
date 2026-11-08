import {
	AD_BODY_MAX,
	AD_FEED_MAX,
	AD_TITLE_MAX,
	ADS_FEED_PATH,
	ADS_FEED_TTL_MS,
	ADS_HEADER_NAMES,
	ADS_PROTO,
	ADS_REQUEST_TIMEOUT_MS,
	type AdAd,
	type AdFeed,
	type AdsSurface,
} from "@usingopen/wire";
import { getInstallId } from "@usingopen/utils/dirs";
import { HOUSE_ADS } from "./house-ads";
import { adsBaseUrl, adsEnabledByEnv, adsFeedCachePath, adsStatePath, readJsonFile, writeJsonAtomic } from "./store";

/**
 * Local ad client for the UsingOpen ad network.
 *
 * Design rules (enforced here, not by the server):
 * - **No tracking beyond the install id.** The only identity sent is the same
 *   per-install UUID the inference gateway already uses (dual-named headers
 *   during the rollout). No session ids, paths, prompts, or hostnames leave.
 * - **Frequency cap.** At most {@link MAX_ADS_PER_SESSION} ads per process and
 *   at most one per {@link MIN_AD_INTERVAL_MS}; dismissed ids never return.
 * - **Degrade to house ads.** A missing, stale, or invalid feed falls back to
 *   {@link HOUSE_ADS} — the UI never waits on the network and never breaks.
 * - **Deterministic selection.** `select` takes the random sample as a
 *   parameter so tests pin rotation.
 */

/** Ads shown per process; further selections return `null`. */
export const MAX_ADS_PER_SESSION = 4;

/** Minimum spacing between two ad surfaces in one process. */
export const MIN_AD_INTERVAL_MS = 90_000;

/** Persisted dismissal + counter state. */
interface AdState {
	readonly dismissed: readonly string[];
	readonly shown: Readonly<Record<string, number>>;
	readonly lastShownAt: number;
}

const EMPTY_STATE: AdState = { dismissed: [], shown: {}, lastShownAt: 0 };

/** Shape of the on-disk feed cache: the feed plus when it was fetched. */
interface FeedCache {
	readonly fetchedAt: number;
	readonly feed: AdFeed;
}

function normalizeAd(raw: unknown): AdAd | null {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	const id = typeof rec.id === "string" ? rec.id.trim() : "";
	const title = typeof rec.title === "string" ? rec.title.trim() : "";
	const body = typeof rec.body === "string" ? rec.body.trim() : "";
	if (!id || !title || !body) return null;
	if (title.length > AD_TITLE_MAX || body.length > AD_BODY_MAX) return null;
	if (rec.kind !== "house" && rec.kind !== "sponsored") return null;
	const cta = typeof rec.cta === "string" && rec.cta.trim() ? rec.cta.trim() : undefined;
	const url = typeof rec.url === "string" && rec.url.startsWith("https://") ? rec.url : undefined;
	const sponsor =
		rec.kind === "sponsored" && typeof rec.sponsor === "string" && rec.sponsor.trim()
			? rec.sponsor.trim()
			: undefined;
	if (rec.kind === "sponsored" && !sponsor) return null;
	const weight = typeof rec.weight === "number" && Number.isFinite(rec.weight) && rec.weight > 0 ? rec.weight : 1;
	return { id, kind: rec.kind, title, body, cta, url, sponsor, weight };
}

/** Parse a feed document, dropping malformed entries; `null` when unusable. */
export function parseAdFeed(raw: unknown): AdFeed | null {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.proto !== "number" || rec.proto > ADS_PROTO || rec.proto < 1) return null;
	if (!Array.isArray(rec.ads)) return null;
	const ads: AdAd[] = [];
	for (const entry of rec.ads) {
		if (ads.length >= AD_FEED_MAX) break;
		const ad = normalizeAd(entry);
		if (ad) ads.push(ad);
	}
	if (ads.length === 0) return null;
	const ttlMs = typeof rec.ttlMs === "number" && rec.ttlMs > 0 ? Math.min(rec.ttlMs, 24 * 60 * 60 * 1000) : undefined;
	return ttlMs === undefined ? { proto: rec.proto, ads } : { proto: rec.proto, ads, ttlMs };
}

function parseAdState(raw: unknown): AdState {
	if (typeof raw !== "object" || raw === null) return EMPTY_STATE;
	const rec = raw as Record<string, unknown>;
	const dismissed = Array.isArray(rec.dismissed)
		? rec.dismissed.filter((v): v is string => typeof v === "string")
		: [];
	const shown: Record<string, number> = {};
	if (typeof rec.shown === "object" && rec.shown !== null) {
		for (const [key, value] of Object.entries(rec.shown as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) shown[key] = Math.floor(value);
		}
	}
	const lastShownAt = typeof rec.lastShownAt === "number" && rec.lastShownAt > 0 ? rec.lastShownAt : 0;
	return { dismissed, shown, lastShownAt };
}

export class AdsClient {
	/** Clock seam: tests inject a fake time to exercise the interval cap. */
	readonly #now: () => number;
	/** In-memory feed: fetched network feed, cached feed, or house ads. */
	#ads: readonly AdAd[] = HOUSE_ADS;
	/** Where the current feed came from; `house` also covers "disabled". */
	#source: "house" | "network" = "house";
	#state: AdState = EMPTY_STATE;
	#loaded = false;
	#sessionShown = 0;
	#lastSelectedAt = 0;
	/** Session kill-switch (`/ads off`), independent of the env var. */
	#sessionEnabled = true;

	constructor(now: () => number = () => Date.now()) {
		this.#now = now;
	}

	/** Ads the client would show right now (house fallback included). */
	get ads(): readonly AdAd[] {
		this.#load();
		return this.#ads;
	}

	/** Provenance of the current feed, for the `/ads` panel and status slot. */
	get source(): "house" | "network" {
		this.#load();
		return this.#source;
	}

	/** Whether any ad surface may show: env switch AND session switch. */
	get enabled(): boolean {
		return adsEnabledByEnv() && this.#sessionEnabled;
	}

	/** Session-level off switch (`/ads off`); persists for the process only. */
	setSessionEnabled(on: boolean): void {
		this.#sessionEnabled = on;
	}

	/** Lazily load state + cache from disk on first use. */
	#load(): void {
		if (this.#loaded) return;
		this.#loaded = true;
		this.#state = parseAdState(readJsonFile(adsStatePath()));
		const cache = readJsonFile<FeedCache>(adsFeedCachePath());
		if (cache && typeof cache.fetchedAt === "number") {
			const feed = parseAdFeed(cache.feed);
			if (feed) {
				const ttl = feed.ttlMs ?? ADS_FEED_TTL_MS;
				if (Date.now() - cache.fetchedAt <= ttl) {
					this.#ads = feed.ads;
					this.#source = "network";
				}
			}
		}
	}

	/**
	 * Fetch the feed from the ad network. Never throws: on any failure the
	 * client keeps the freshest feed it has (cache, then house ads). Only the
	 * install id is sent, under both the current and legacy header names.
	 * `fetchImpl` exists for tests; production passes nothing.
	 */
	async refresh(fetchImpl: typeof fetch = fetch): Promise<void> {
		this.#load();
		if (!adsEnabledByEnv()) return;
		const base = adsBaseUrl();
		try {
			const response = await fetchImpl(`${base}${ADS_FEED_PATH}`, {
				method: "GET",
				headers: {
					accept: "application/json",
					[ADS_HEADER_NAMES.installId]: getInstallId(),
					[ADS_HEADER_NAMES.legacyInstallId]: getInstallId(),
				},
				signal: AbortSignal.timeout(ADS_REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) return;
			const feed = parseAdFeed(await response.json());
			if (!feed) return;
			this.#ads = feed.ads;
			this.#source = "network";
			writeJsonAtomic(adsFeedCachePath(), { fetchedAt: Date.now(), feed } satisfies FeedCache);
		} catch {
			// Offline, DNS failure, timeout, or a read-only home: keep what we have.
		}
	}

	/**
	 * Pick an ad for `surface` under the frequency cap and dismissal list.
	 * Returns `null` when ads are off, the session cap is hit, the minimum
	 * interval has not elapsed, or every ad is dismissed. `r` is a uniform
	 * sample in [0, 1); callers pass `Math.random()`, tests pass a constant.
	 */
	select(surface: AdsSurface, r: number): AdAd | null {
		void surface;
		this.#load();
		if (!this.enabled) return null;
		const now = this.#now();
		if (this.#sessionShown >= MAX_ADS_PER_SESSION) return null;
		if (this.#lastSelectedAt > 0 && now - this.#lastSelectedAt < MIN_AD_INTERVAL_MS) return null;
		const dismissed = new Set(this.#state.dismissed);
		const candidates = this.#ads.filter(ad => !dismissed.has(ad.id));
		if (candidates.length === 0) return null;
		const weights = candidates.map(ad => ad.weight ?? 1);
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		let acc = r * total;
		let picked = candidates[0] as AdAd;
		for (let i = 0; i < candidates.length; i++) {
			acc -= weights[i] ?? 1;
			if (acc < 0) {
				picked = candidates[i] as AdAd;
				break;
			}
		}
		this.#sessionShown += 1;
		this.#lastSelectedAt = now;
		this.#state = {
			dismissed: this.#state.dismissed,
			shown: { ...this.#state.shown, [picked.id]: (this.#state.shown[picked.id] ?? 0) + 1 },
			lastShownAt: now,
		};
		writeJsonAtomic(adsStatePath(), this.#state);
		return picked;
	}

	/** Persist a dismissal; the ad never reappears on this install. */
	dismiss(id: string): void {
		this.#load();
		if (this.#state.dismissed.includes(id)) return;
		this.#state = { ...this.#state, dismissed: [...this.#state.dismissed, id] };
		writeJsonAtomic(adsStatePath(), this.#state);
	}

	/** Show counts per ad id (for the `/ads` panel diagnostics). */
	shownCounts(): Readonly<Record<string, number>> {
		this.#load();
		return this.#state.shown;
	}

	/** Dismissed ids (for the `/ads` panel diagnostics). */
	dismissedIds(): readonly string[] {
		this.#load();
		return this.#state.dismissed;
	}

	/** Latched ad for the status-line slot: chosen once per process so the
	 *  slot renders deterministically without spending the frequency cap. */
	#statusAdChecked = false;
	#statusAd: AdAd | null = null;
	statusAd(): AdAd | null {
		if (!this.#statusAdChecked) {
			this.#statusAdChecked = true;
			this.#statusAd = this.select("status", Math.random());
		}
		return this.#statusAd;
	}
}

let singleton: AdsClient | undefined;

/** Process-wide ad client; the TUI never instantiates more than one. */
export function getAdsClient(): AdsClient {
	singleton ??= new AdsClient();
	return singleton;
}

/** Test seam: drop the singleton and any session state. */
export function resetAdsClientForTest(): void {
	singleton = undefined;
}
