import type { AdAd } from "@usingopen/wire";
import { theme } from "../theme/theme";
import { visibleWidth, wrapTextWithAnsi } from "../utils";
import { truncateToWidth } from "../render/render-utils";

/**
 * Terminal renderers for the ad surfaces. All of them degrade gracefully:
 * every helper takes a plain {@link AdAd} and pure width parameters, so the
 * splash, welcome, footer, status line, idle card, and post-task card share
 * one visual language and stay testable without a terminal.
 */

/** Tag prefix marking a tip as paid placement (house ads get the same marker
 *  with the sponsor replaced by `UsingOpen`). */
export function adSponsorLabel(ad: AdAd): string {
	return ad.kind === "house" ? "UsingOpen" : (ad.sponsor ?? "sponsored");
}

/** Tip-style one-liner for the tips rotation: `Sponsored · title — body`. */
export function adTipText(ad: AdAd): string {
	const label = ad.kind === "house" ? "From UsingOpen" : `Sponsored by ${adSponsorLabel(ad)}`;
	return `${label} · ${ad.title} — ${ad.body}`;
}

/** Compact single-line form for the footer/status slot: `◆ title`. */
export function adCompactText(ad: AdAd): string {
	return `◆ ${ad.title}`;
}

/** Status-slot text: the current ad, or an explicit "off" marker. */
export function adStatusText(ad: AdAd | null): string {
	return ad === null ? "ads off" : `◆ ${adSponsorLabel(ad)}`;
}

/** CTA button label: the ad's own label, else a neutral default. */
export function adCtaLabel(ad: AdAd): string {
	return ad.cta?.trim() || "Learn more";
}

/** A cta that reads as a domain (`example.com`, `example.com/docs`), used as
 *  the card's domain when the ad carries no url. */
const DOMAIN_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i;

/** Domain shown beside the CTA: the ad URL's host, else a domain-shaped cta. */
export function adDomain(ad: AdAd): string | undefined {
	if (ad.url) {
		try {
			const host = new URL(ad.url).host;
			if (host) return host;
		} catch {
			// Not a parseable URL: fall back to the cta text below.
		}
	}
	const cta = ad.cta?.trim();
	return cta && DOMAIN_LIKE.test(cta) ? cta : undefined;
}

/** Body of the ad wrapped to `width`, every line prefixed with `indent`. */
function wrappedBody(ad: AdAd, width: number, indent: string): string[] {
	const inner = Math.max(12, width - visibleWidth(indent));
	return wrapTextWithAnsi(ad.body, inner).map(line => `${indent}${line}`);
}

/**
 * A boxed ad card for the idle-time surface and the `/ads` panel:
 *
 * ```
 * ┌─ ◆ UsingOpen Ads ─ house ─────────────────┐
 * │ Pair up live                              │
 * │ `/collab` streams your session…           │
 * │ → usingopen.com/docs/collab               │
 * └───────────────────────────────────────────┘
 * ```
 */
export function renderAdCard(ad: AdAd, width: number): string[] {
	const boxWidth = Math.max(28, Math.min(width, 72));
	const inner = boxWidth - 2;
	const tag = ad.kind === "house" ? "house" : `sponsored · ${adSponsorLabel(ad)}`;
	const header = ` UsingOpen Ads · ${tag} `;
	// ┌─ + ◆ + header + fill + ┐ must total boxWidth = inner + 2, so the header
	// and its fill share inner - 2 columns; truncate (with an ellipsis) when the
	// sponsor name makes the header too wide for a narrow card.
	const headerFit = truncateToWidth(header, Math.max(8, inner - 2));
	const headerFill = Math.max(0, inner - 2 - visibleWidth(headerFit));
	const accent = theme.fg("accent", "◆");
	const lines: string[] = [];
	lines.push(`┌─${accent}${theme.bold(headerFit)}${"─".repeat(headerFill)}┐`);
	const titleLines = wrapTextWithAnsi(theme.bold(ad.title), inner - 2);
	for (const line of titleLines) lines.push(`│ ${padEnd(line, inner - 2)} │`);
	for (const line of wrappedBody(ad, inner, " ")) lines.push(`│${padEnd(line, inner)}│`);
	if (ad.cta) lines.push(`│ ${padEnd(theme.fg("dim", `→ ${ad.cta}`), inner - 2)} │`);
	lines.push(`└${"─".repeat(inner)}┘`);
	return lines;
}

/** Idle card: the ad card preceded by a "while you wait" caption. */
export function renderIdleAdCard(ad: AdAd, width: number): string[] {
	return [theme.fg("dim", "While you wait — one word from our sponsor network:"), ...renderAdCard(ad, width)];
}

/**
 * The post-task ad card (Freebuff Terminal parity): an `Ad` label in the top
 * border, the bold title, the wrapped body, and a CTA row carrying a bracketed
 * button, the ad domain, and a right-aligned dismiss affordance:
 *
 * ```
 * ╭─ Ad ────────────────────────────────╮
 * │ Ship faster                         │
 * │ Parallel pipelines, zero config.    │
 * │ [ Try it free ]  acme.example   ✕   │
 * ╰─────────────────────────────────────╯
 * ```
 *
 * Narrower cards drop the domain, then the dismiss marker, rather than wrap
 * the CTA row; the title and body always wrap. The card carries no link
 * behavior — the terminal shows the domain as text and the host binds the key
 * that opens it (see docs/ads.md).
 */
export function renderPostTaskAdCard(ad: AdAd, width: number): string[] {
	const boxWidth = Math.max(28, Math.min(width, 72));
	const inner = boxWidth - 2;
	const label = "Ad";
	const lines: string[] = [];
	// ╭─ Ad ──fill──╮: the label and its fill share inner - 3 columns so the row
	// totals inner + 2 like every other box in this file.
	lines.push(`╭─ ${theme.fg("dim", label)} ${"─".repeat(Math.max(0, inner - 3 - visibleWidth(label)))}╮`);
	const titleLines = wrapTextWithAnsi(theme.bold(ad.title), inner - 2);
	for (const line of titleLines) lines.push(`│ ${padEnd(line, inner - 2)} │`);
	const bodyLines = wrappedBody(ad, inner, " ");
	if (bodyLines.length > 0) {
		for (const line of bodyLines) lines.push(`│${padEnd(line, inner)}│`);
	}
	lines.push(`│ ${padEnd(postTaskCtaRow(ad, inner - 2), inner - 2)} │`);
	lines.push(`╰${"─".repeat(inner)}╯`);
	return lines;
}

/** The card's CTA row: `[ label ]  domain` with `✕` right-aligned. Degenerate
 *  widths drop the domain, then the dismiss marker, never the button. */
function postTaskCtaRow(ad: AdAd, width: number): string {
	const button = truncateToWidth(theme.fg("accent", `[ ${adCtaLabel(ad)} ]`), width);
	const dismiss = theme.fg("dim", "✕");
	const gap = 2;
	const tail = 1 + visibleWidth(dismiss); // one space, then the marker
	const room = width - visibleWidth(button);
	if (room < tail) return button;
	const domain = adDomain(ad);
	if (domain !== undefined && room - gap - tail >= visibleWidth(domain)) {
		const pad = room - gap - tail - visibleWidth(domain);
		return `${button}  ${theme.fg("dim", domain)}${" ".repeat(pad)} ${dismiss}`;
	}
	return `${button}${" ".repeat(room - tail)} ${dismiss}`;
}

/** Pad `text` with spaces to `width` visible columns (ANSI-safe). */
function padEnd(text: string, width: number): string {
	const pad = width - visibleWidth(text);
	return pad > 0 ? text + " ".repeat(pad) : text;
}
