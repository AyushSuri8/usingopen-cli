import type { AdAd } from "@usingopen/wire";
import { OverlayPanel } from "../chrome/overlay-box";
import { theme } from "../theme/theme";
import { truncateToWidth, wrapTextWithAnsi } from "../render/render-utils";
import { col, span, text } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { plainText } from "../native/spans";
import { HOUSE_ADS } from "../ads/house-ads";
import { getAdsClient } from "../ads/client";
import { adSponsorLabel } from "../ads/render";

/**
 * State model for the `/ads` panel: the current feed plus the panel's own
 * cursor. The host (coding-agent) binds keys to the actions; the component
 * renders the model. Keeping them apart matches the rest of the TUI panels
 * and keeps the model unit-testable without a terminal.
 */
export class AdsPanelModel {
	#cursor = 0;
	/** Set while a refresh is in flight so the panel can show a spinner row. */
	#refreshing = false;
	/** Last refresh outcome for the status row; `undefined` before the first try. */
	#lastRefresh: "ok" | "failed" | "off" | undefined;

	constructor(private readonly client = getAdsClient()) {}

	/** Rows for the list: the client's current feed with per-row flags. */
	entries(): { ad: AdAd; dismissed: boolean; shown: number }[] {
		const dismissed = new Set(this.client.dismissedIds());
		const shown = this.client.shownCounts();
		return this.client.ads.map(ad => ({
			ad,
			dismissed: dismissed.has(ad.id),
			shown: shown[ad.id] ?? 0,
		}));
	}

	get cursor(): number {
		return this.#cursor;
	}

	get refreshing(): boolean {
		return this.#refreshing;
	}

	get lastRefresh(): "ok" | "failed" | "off" | undefined {
		return this.#lastRefresh;
	}

	/** Whether the ad network is on (env + session switches). */
	get enabled(): boolean {
		return this.client.enabled;
	}

	/** Where the current feed came from. */
	get source(): "house" | "network" {
		return this.client.source;
	}

	move(delta: number): void {
		const count = this.entries().length;
		if (count === 0) return;
		this.#cursor = (this.#cursor + delta + count) % count;
	}

	get selectedId(): string | undefined {
		return this.entries()[this.#cursor]?.ad.id;
	}

	/** Dismiss the selected ad (never returns on this install). */
	dismissSelected(): void {
		const id = this.selectedId;
		if (id) this.client.dismiss(id);
	}

	/** Toggle the session-level off switch (`/ads off` / `/ads on`). */
	toggleEnabled(): void {
		this.client.setSessionEnabled(!this.client.enabled);
	}

	/** Fetch the network feed; records the outcome for the status row. */
	async refresh(): Promise<void> {
		if (!this.client.enabled) {
			this.#lastRefresh = "off";
			return;
		}
		this.#refreshing = true;
		const before = this.client.source;
		await this.client.refresh();
		this.#refreshing = false;
		this.#lastRefresh = this.client.source === "network" || before === "network" ? "ok" : "failed";
	}
}

/** Status-line text for the panel header: source + on/off state. */
function sourceLabel(model: AdsPanelModel): string {
	if (!model.enabled) return "off";
	return model.source === "network" ? "live" : "house ads (feed unreachable)";
}

/** One list row: cursor, marker, title, sponsor, counters. */
function rowText(entry: { ad: AdAd; dismissed: boolean; shown: number }, index: number, cursor: number): string {
	const pointer = index === cursor ? theme.fg("accent", "▸") : " ";
	const marker = entry.dismissed ? theme.fg("dim", "dismissed") : adSponsorLabel(entry.ad);
	const title = entry.dismissed ? theme.fg("dim", entry.ad.title) : theme.bold(entry.ad.title);
	const counters = theme.fg("dim", `shown ${entry.shown}`);
	return truncateToWidth(`${pointer} ${title}  ${theme.fg("dim", `[${marker}]`)}  ${counters}`, 1e9);
}

/**
 * The `/ads` panel: the current feed with dismissal state, the network
 * status, and the key hints the host binds. Renders on top of the
 * {@link OverlayPanel} chrome; natively it is a card with the same rows.
 */
export class AdsPanelComponent extends OverlayPanel {
	readonly interactive = true;

	constructor(private readonly model: AdsPanelModel) {
		super("UsingOpen Ads", "usingopen.overlay.ads");
	}

	#hints(): string {
		return theme.fg("dim", "↑↓ select · d dismiss · r refresh · o on/off · esc close");
	}

	#statusLine(): string {
		const refresh = this.model.refreshing
			? " · refreshing…"
			: this.model.lastRefresh === undefined
				? ""
				: this.model.lastRefresh === "ok"
					? " · refreshed"
					: this.model.lastRefresh === "off"
						? " · ads are off"
						: " · refresh failed (kept current feed)";
		return theme.fg("dim", `Network: ${sourceLabel(this.model)}${refresh}`);
	}

	override render(width: number): readonly string[] {
		const inner = Math.max(20, width);
		const entries = this.model.entries();
		const lines: string[] = [this.#statusLine(), ""];
		if (entries.length === 0) {
			lines.push(theme.fg("dim", "No ads available — every ad is dismissed."));
		}
		for (const [index, entry] of entries.entries()) {
			lines.push(rowText(entry, index, this.model.cursor));
			if (index === this.model.cursor) {
				for (const line of wrapTextWithAnsi(plainText(entry.ad.body), inner - 4)) {
					lines.push(theme.fg("dim", `    ${line}`));
				}
				if (entry.ad.url) lines.push(theme.fg("dim", `    ${entry.ad.url}`));
			}
			lines.push("");
		}
		if (this.model.source === "house") {
			lines.push(theme.fg("dim", `Falling back to ${HOUSE_ADS.length} built-in UsingOpen house ads.`));
		}
		lines.push(this.#hints());
		return lines;
	}

	override describe(_cx: DescribeContext): NativeNode {
		const entries = this.model.entries();
		const children = entries.map((entry, index) =>
			col(
				[
					text(
						[
							span(index === this.model.cursor ? "▸ " : "", "accent"),
							span(entry.ad.title, "strong"),
							span(`  [${entry.dismissed ? "dismissed" : adSponsorLabel(entry.ad)}]`, "dim"),
						],
						{ wrap: "none" },
					),
					text([span(entry.ad.body, "dim")], { wrap: "word" }),
				],
				{ gap: "xs", role: "usingopen.ads.row" },
			),
		);
		if (children.length === 0) {
			children.push(text([span("No ads available — every ad is dismissed.", "dim")], { wrap: "word" }));
		}
		return col(
			[text([span(sourceLabel(this.model), "dim")], { wrap: "none", role: "usingopen.ads.status" }), ...children],
			{ gap: "sm", role: "usingopen.ads" },
		);
	}
}
