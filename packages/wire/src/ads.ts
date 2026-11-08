/**
 * Wire types for the UsingOpen ad network (`ads.usingopen.com`).
 *
 * UsingOpen runs its own ad network — there is no third-party ad SDK, no
 * Google, and no tracking beyond the per-install id (sent as the same
 * attribution headers the inference gateway uses; see {@link ADS_HEADER_NAMES}).
 * The client fetches a small JSON feed, caches it on disk, and enforces a
 * per-surface frequency cap locally; dismissed ads stay dismissed.
 *
 * Unknown shapes are dropped at the parse boundary; a missing or broken feed
 * degrades to the built-in house ads (`packages/tui/src/ads/house-ads.ts`), so a
 * cold host, an outage, or `USINGOPEN_ADS=0` never blocks the UI.
 */

/** Default ad server; overridable per-install with `USINGOPEN_ADS_URL`. */
export const DEFAULT_ADS_URL = "https://ads.usingopen.com";

/** Feed schema version; the client refuses feeds advertising a newer one. */
export const ADS_PROTO = 1;

/** Feed endpoint appended to the ad server base. */
export const ADS_FEED_PATH = "/v1/feed";

/** Impression beacon endpoint appended to the ad server base (docs/advertise.md). */
export const ADS_IMPRESSION_PATH = "/v1/impression";

/** Request timeout: ads are decoration, never a startup gate. */
export const ADS_REQUEST_TIMEOUT_MS = 4000;

/** Cache lifetime for a fetched feed; older caches are refetched once per day at most. */
export const ADS_FEED_TTL_MS = 6 * 60 * 60 * 1000;

/** Attribution headers: current name first, legacy `x-omp-*` sent alongside during the rollout. */
export const ADS_HEADER_NAMES = {
	installId: "x-usingopen-install-id",
	legacyInstallId: "x-omp-install-id",
} as const;

/** Placement the selection is made for; the server may weight ads per surface. */
export const ADS_SURFACES = ["welcome", "splash", "footer", "status", "idle", "panel", "post-task"] as const;

/** One surface from {@link ADS_SURFACES}. */
export type AdsSurface = (typeof ADS_SURFACES)[number];

/** A single ad. `kind` distinguishes the network's own promos from third-party spots. */
export interface AdAd {
	/** Stable id; the dismiss list and frequency counters key on it. */
	readonly id: string;
	/** `house` for UsingOpen promos, `sponsored` for third-party placements. */
	readonly kind: "house" | "sponsored";
	/** Short headline (<= 60 chars enforced by the client). */
	readonly title: string;
	/** One or two sentences (<= 200 chars enforced by the client). */
	readonly body: string;
	/** Optional call-to-action label; rendered without `url` as plain copy. */
	readonly cta?: string;
	/** Optional link; shown as text in the TUI (the terminal never auto-opens). */
	readonly url?: string;
	/** Sponsor name for `sponsored` ads; omitted for house ads. */
	readonly sponsor?: string;
	/** Selection weight; defaults to 1. Higher shows more often. */
	readonly weight?: number;
}

/** Feed document served by the ad network and mirrored in the on-disk cache. */
export interface AdFeed {
	/** Schema version; must be <= {@link ADS_PROTO}. */
	readonly proto: number;
	readonly ads: readonly AdAd[];
	/** Server-side TTL override in milliseconds; clamped client-side. */
	readonly ttlMs?: number;
}

/** Longest accepted title; longer entries are dropped, not truncated. */
export const AD_TITLE_MAX = 60;
/** Longest accepted body; longer entries are dropped, not truncated. */
export const AD_BODY_MAX = 200;
/** Ads per feed; the remainder of a longer list is ignored. */
export const AD_FEED_MAX = 12;
