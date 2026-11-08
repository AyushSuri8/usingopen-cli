import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdAd } from "@usingopen/wire";
import {
	adCompactText,
	adCtaLabel,
	adDomain,
	adSponsorLabel,
	adStatusText,
	adTipText,
	renderAdCard,
	renderIdleAdCard,
	renderPostTaskAdCard,
} from "@usingopen/tui/ads/render";
import { AdsPanelModel } from "@usingopen/tui/overlays/ads-panel";
import { AdsClient } from "@usingopen/tui/ads/client";
import { initTheme } from "@usingopen/tui/theme";

/** Isolate ad state from the real home: a unique config dir per file. */
const TEST_CONFIG_DIR = `.usingopen-ads-render-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let savedConfigDir: string | undefined;
let savedHome: string | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	savedConfigDir = process.env.USINGOPEN_CONFIG_DIR;
	savedHome = process.env.HOME;
	process.env.USINGOPEN_CONFIG_DIR = TEST_CONFIG_DIR;
	process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usingopen-ads-render-"));
});

afterEach(() => {
	if (savedConfigDir === undefined) delete process.env.USINGOPEN_CONFIG_DIR;
	else process.env.USINGOPEN_CONFIG_DIR = savedConfigDir;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	fs.rmSync(path.join(process.env.HOME ?? "", TEST_CONFIG_DIR), { recursive: true, force: true });
});

const houseAd: AdAd = {
	id: "t.house",
	kind: "house",
	title: "Pair up live",
	body: "`/collab` streams your session over an end-to-end encrypted relay.",
	cta: "usingopen.com/docs/collab",
	url: "https://usingopen.com/docs/collab",
};

const sponsoredAd: AdAd = {
	id: "t.sponsored",
	kind: "sponsored",
	title: "Ship faster",
	body: "A very long body that must wrap across several terminal lines so the card renderer exercises its wrapping path.",
	sponsor: "Acme Robotics",
};

/** Strip ANSI so assertions measure the visible columns. */
function plain(lines: readonly string[]): string[] {
	return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

describe("ad text helpers", () => {
	it("labels house ads with UsingOpen and sponsored ads with the sponsor", () => {
		expect(adSponsorLabel(houseAd)).toBe("UsingOpen");
		expect(adSponsorLabel(sponsoredAd)).toBe("Acme Robotics");
	});

	it("marks paid placement in tips", () => {
		expect(adTipText(houseAd)).toContain("From UsingOpen");
		expect(adTipText(sponsoredAd)).toContain("Sponsored by Acme Robotics");
		expect(adTipText(houseAd)).toContain(houseAd.title);
	});

	it("renders compact and status forms", () => {
		expect(adCompactText(houseAd)).toBe(`◆ ${houseAd.title}`);
		expect(adStatusText(null)).toBe("ads off");
		expect(adStatusText(sponsoredAd)).toContain("Acme Robotics");
	});
});

describe("renderAdCard", () => {
	it("draws a closed box with the title, wrapped body, and cta", () => {
		const rows = renderAdCard(houseAd, 60);
		expect(rows.length).toBeGreaterThanOrEqual(5);
		expect(rows[0]?.startsWith("┌─")).toBe(true);
		expect(rows[rows.length - 1]?.startsWith("└")).toBe(true);
		expect(rows.some(row => row.includes(houseAd.title))).toBe(true);
		expect(rows.some(row => row.includes("→ usingopen.com/docs/collab"))).toBe(true);
		expect(rows.some(row => row.includes("house"))).toBe(true);
	});

	it("wraps long bodies inside the box without overflowing", () => {
		const rows = renderAdCard(sponsoredAd, 40);
		for (const row of rows) {
			// Box chars are single-width; the card must stay within 40 columns.
			expect(row.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(40);
		}
	});

	it("shows the sponsor once the card is wide enough", () => {
		const rows = renderAdCard(sponsoredAd, 72);
		expect(rows.some(row => row.includes("Acme Robotics"))).toBe(true);
		expect(rows.some(row => row.includes("sponsored"))).toBe(true);
	});

	it("prefixes the idle card with a caption", () => {
		const rows = renderIdleAdCard(houseAd, 60);
		expect(rows[0]).toContain("While you wait");
		expect(rows.length).toBeGreaterThan(renderAdCard(houseAd, 60).length);
	});
});

describe("ad cta helpers", () => {
	it("labels a missing cta with the default and reads the domain from the url", () => {
		const bare: AdAd = { id: "t.bare", kind: "sponsored", title: "T", body: "B", sponsor: "Acme" };
		expect(adCtaLabel(bare)).toBe("Learn more");
		expect(adCtaLabel(houseAd)).toBe("usingopen.com/docs/collab");
		expect(adDomain(houseAd)).toBe("usingopen.com");
		expect(adDomain({ ...houseAd, url: undefined })).toBe("usingopen.com/docs/collab");
		expect(adDomain(bare)).toBeUndefined();
	});

	it("ignores a cta that is not domain-shaped when there is no url", () => {
		const copy: AdAd = {
			id: "t.copy",
			kind: "sponsored",
			title: "T",
			body: "B",
			cta: "Try it free",
			sponsor: "Acme",
		};
		expect(adDomain(copy)).toBeUndefined();
	});
});

describe("renderPostTaskAdCard", () => {
	const ctaAd: AdAd = {
		id: "t.cta",
		kind: "sponsored",
		title: "Ship faster",
		body: "Parallel pipelines with zero config for busy teams.",
		cta: "Try it free",
		url: "https://acme.example/start",
		sponsor: "Acme Robotics",
	};

	it("draws a closed Ad-labeled box with the title, body, cta button, domain, and dismiss affordance", () => {
		const rows = plain(renderPostTaskAdCard(ctaAd, 72));
		expect(rows[0]?.startsWith("╭─ Ad ")).toBe(true);
		expect(rows[rows.length - 1]?.startsWith("╰")).toBe(true);
		expect(rows.some(row => row.includes("Ship faster"))).toBe(true);
		expect(rows.some(row => row.includes("Parallel pipelines with zero config"))).toBe(true);
		// One row carries the whole CTA line: bracketed button, domain, dismiss.
		const ctaRow = rows.find(row => row.includes("[ Try it free ]"));
		expect(ctaRow).toBeDefined();
		expect(ctaRow).toContain("acme.example");
		expect(ctaRow).toContain("✕");
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(72);
	});

	it("keeps every row inside the box at narrow widths, dropping the domain before the button", () => {
		const narrow = plain(renderPostTaskAdCard(ctaAd, 30));
		expect(narrow.length).toBeGreaterThan(4); // border + title + wrapped body + cta + bottom
		const narrowCta = narrow.find(row => row.includes("[ Try it free ]"));
		expect(narrowCta).toBeDefined();
		// The domain goes first; the button and the dismiss affordance stay.
		expect(narrowCta).not.toContain("acme.example");
		expect(narrowCta).toContain("✕");
		for (const row of narrow) expect(row.length).toBeLessThanOrEqual(30);
	});

	it("falls back to the house card for an ad without url or domain-shaped cta", () => {
		const rows = plain(
			renderPostTaskAdCard({ id: "t.nolink", kind: "house", title: "T", body: "B", cta: "Learn more" }, 72),
		);
		const ctaRow = rows.find(row => row.includes("[ Learn more ]"));
		expect(ctaRow).toBeDefined();
		expect(ctaRow).toContain("✕");
	});
});

describe("AdsPanelModel", () => {
	it("lists the feed with dismissal and shown counters", () => {
		const client = new AdsClient(() => 1);
		// House feed is the fallback source in tests (no network).
		const model = new AdsPanelModel(client);
		const entries = model.entries();
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every(entry => entry.shown === 0 && !entry.dismissed)).toBe(true);
		expect(model.cursor).toBe(0);
	});

	it("moves the cursor with wraparound and dismisses the selection", () => {
		const client = new AdsClient(() => 1);
		const model = new AdsPanelModel(client);
		const count = model.entries().length;
		model.move(1);
		expect(model.cursor).toBe(1 % count);
		model.move(-1);
		expect(model.cursor).toBe(0);
		model.move(-1);
		expect(model.cursor).toBe(count - 1);
		const target = model.selectedId;
		expect(target).toBeDefined();
		model.dismissSelected();
		expect(model.entries().find(entry => entry.ad.id === target)?.dismissed).toBe(true);
	});

	it("refresh without a network keeps the house feed and records the outcome", async () => {
		const client = new AdsClient(() => 1);
		const model = new AdsPanelModel(client);
		// Offline by construction: live networks (like this dev host reaching
		// the real feed) must not flip the outcome.
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		try {
			await model.refresh();
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(model.lastRefresh).toBe("failed");
		expect(model.source).toBe("house");
		expect(model.refreshing).toBe(false);
	});

	it("toggleEnabled flips the session switch", () => {
		const client = new AdsClient(() => 1);
		const model = new AdsPanelModel(client);
		const before = model.enabled;
		model.toggleEnabled();
		expect(model.enabled).toBe(!before);
	});
});
