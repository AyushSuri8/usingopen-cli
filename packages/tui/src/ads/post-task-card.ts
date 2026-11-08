import type { AdAd } from "@usingopen/wire";
import { col, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionButton } from "../native/overlay";
import { isNativeRendering } from "../native/state";
import { getAdsClient } from "./client";
import { adCtaLabel, adDomain, renderPostTaskAdCard } from "./render";

/**
 * The post-task ad card: shown above the prompt once a turn ends, matching the
 * Freebuff Terminal layout (an `Ad` label, the bold title, the body, a CTA
 * button with the ad domain, and a dismiss affordance).
 *
 * One ad is latched per card instance and comes from the same client as every
 * other surface, so the frequency cap, the dismissal list, and the house-ad
 * fallback all apply: a capped or disabled client latches nothing and the card
 * renders empty, which tells the host to leave it unmounted. Dismissing
 * persists the ad id (it never returns on this install) and unmounts the card
 * through the host's dismiss callback.
 *
 * The card is decoration: it never blocks the prompt, never auto-opens a link,
 * and survives a missing feed by showing a house ad instead.
 */
export class PostTaskAdCard {
	#latched = false;
	#ad: AdAd | null = null;

	constructor(private readonly onDismiss?: () => void) {}

	/** The latched ad, or `null` when ads are off, capped, or dismissed. */
	get ad(): AdAd | null {
		if (!this.#latched) {
			this.#latched = true;
			this.#ad = getAdsClient().select("post-task", Math.random());
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
		return renderPostTaskAdCard(ad, width);
	}

	/** Native description; `null` falls back to {@link render}. The CTA carries
	 *  the ad URL as its `href` so the terminal opens it on click; the dismiss
	 *  button routes back here as a `dismiss` action. */
	describe(_cx: DescribeContext): NativeNode | null {
		if (!isNativeRendering()) return null;
		const ad = this.ad;
		if (!ad) return null;
		const domain = adDomain(ad);
		const cta: NativeChild[] = [
			actionButton(adCtaLabel(ad), "open", ad.url ? { href: ad.url, title: ad.url } : { title: adCtaLabel(ad) }),
		];
		if (domain !== undefined) cta.push(text([span(domain, "dim")], { wrap: "none" }));
		cta.push(actionButton("✕", "dismiss", { title: "Dismiss this ad" }));
		return col(
			[
				row([node("badge", { text: "Ad" }), text([span(ad.title, "strong")], { wrap: "word" })], {
					gap: "sm",
					align: "center",
					role: "usingopen.ads.post-task.title",
				}),
				text([span(ad.body, "dim")], { wrap: "word" }),
				row(cta, { gap: "sm", align: "center", role: "usingopen.ads.post-task.cta" }),
			],
			{ gap: "sm", role: "usingopen.ads.post-task" },
		);
	}

	/** Route the native dismiss button to {@link dismiss}; `open` belongs to the terminal. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "dismiss") this.dismiss();
	}
}
