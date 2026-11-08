import type { AdAd } from "@usingopen/wire";
import type { DescribeContext, NativeNode } from "../native/node";
import { col, span, text } from "../native/describe";
import { isNativeRendering } from "../native/state";
import { getAdsClient } from "./client";
import { renderIdleAdCard } from "./render";

/**
 * The idle-time ad card: shown by the host while a session waits on the user
 * (no turn running, editor idle). One ad is latched per card instance; the
 * frequency cap in the ad client still applies, and a capped or disabled
 * client renders nothing so an idle session is never worse than no card.
 *
 * The card is decoration: `dismiss()` removes the ad (persisted) and unmounts
 * the card via the host's dismiss callback.
 */
export class IdleAdCard {
	#latched = false;
	#ad: AdAd | null = null;

	constructor(private readonly onDismiss?: () => void) {}

	/** The latched ad, or `null` when ads are off or capped. */
	get ad(): AdAd | null {
		if (!this.#latched) {
			this.#latched = true;
			this.#ad = getAdsClient().select("idle", Math.random());
		}
		return this.#ad;
	}

	/** Persist the dismissal and tell the host to unmount the card. */
	dismiss(): void {
		const ad = this.ad;
		if (ad) getAdsClient().dismiss(ad.id);
		this.#ad = null;
		this.onDismiss?.();
	}

	/** Rendered rows at `width`; empty when there is no ad to show. */
	render(width: number): readonly string[] {
		const ad = this.ad;
		if (!ad) return [];
		return renderIdleAdCard(ad, width);
	}

	/** Native description; `null` falls back to {@link render}. */
	describe(_cx: DescribeContext): NativeNode | null {
		if (!isNativeRendering()) return null;
		const ad = this.ad;
		if (!ad) return null;
		return col(
			[
				text([span("While you wait — one word from our sponsor network:", "dim")], { wrap: "word" }),
				text([span(ad.title, "strong")], { wrap: "word" }),
				text([span(ad.body, "dim")], { wrap: "word" }),
			],
			{ gap: "xs", role: "usingopen.ads.idle" },
		);
	}
}
