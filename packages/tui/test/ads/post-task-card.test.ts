import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PostTaskAdCard } from "@usingopen/tui/ads/post-task-card";
import { getAdsClient, resetAdsClientForTest } from "@usingopen/tui/ads/client";
import { HOUSE_ADS } from "@usingopen/tui/ads/house-ads";
import { initTheme } from "@usingopen/tui/theme";

/** Unique config-dir name per test file so state never touches the real home. */
const TEST_CONFIG_DIR = `.usingopen-ads-posttask-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let savedConfigDir: string | undefined;
let savedAds: string | undefined;
let savedHome: string | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	savedConfigDir = process.env.USINGOPEN_CONFIG_DIR;
	savedAds = process.env.USINGOPEN_ADS;
	savedHome = process.env.HOME;
	process.env.USINGOPEN_CONFIG_DIR = TEST_CONFIG_DIR;
	delete process.env.USINGOPEN_ADS;
	// The store resolves the config root through os.homedir(); on platforms
	// where that is not HOME, pin a temp home so the test stays hermetic.
	process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usingopen-ads-posttask-"));
	resetAdsClientForTest();
});

afterEach(() => {
	if (savedConfigDir === undefined) delete process.env.USINGOPEN_CONFIG_DIR;
	else process.env.USINGOPEN_CONFIG_DIR = savedConfigDir;
	if (savedAds === undefined) delete process.env.USINGOPEN_ADS;
	else process.env.USINGOPEN_ADS = savedAds;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	fs.rmSync(path.join(process.env.HOME ?? "", TEST_CONFIG_DIR), { recursive: true, force: true });
	resetAdsClientForTest();
});

describe("PostTaskAdCard", () => {
	it("latches a house ad and renders the card when no feed is reachable", () => {
		const card = new PostTaskAdCard();
		const ad = card.ad;
		expect(ad).not.toBeNull();
		expect(HOUSE_ADS.some(house => house.id === ad?.id)).toBe(true);
		const rows = card.render(60);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some(row => row.includes(ad?.title ?? ""))).toBe(true);
	});

	it("dismiss persists the ad id across clients, empties the card, and unmounts it once", () => {
		let unmounts = 0;
		const card = new PostTaskAdCard(() => {
			unmounts += 1;
		});
		const ad = card.ad;
		expect(ad).not.toBeNull();
		if (!ad) throw new Error("post-task card latched no ad");
		card.dismiss();
		expect(card.ad).toBeNull();
		expect(card.render(60)).toEqual([]);
		expect(unmounts).toBe(1);
		// A fresh client reads the persisted state: the dismissal is not
		// process-local, so the ad never returns on this install.
		expect(getAdsClient().dismissedIds()).toContain(ad.id);
		resetAdsClientForTest();
		expect(getAdsClient().dismissedIds()).toContain(ad.id);
	});

	it("renders nothing while the env kill switch is off", () => {
		process.env.USINGOPEN_ADS = "0";
		const card = new PostTaskAdCard();
		expect(card.ad).toBeNull();
		expect(card.render(60)).toEqual([]);
	});

	it("shares the client's frequency cap so a second card in the interval latches nothing", () => {
		const first = new PostTaskAdCard();
		expect(first.ad).not.toBeNull();
		const second = new PostTaskAdCard();
		expect(second.ad).toBeNull();
	});

	it("dismisses from the native dismiss action", () => {
		const card = new PostTaskAdCard();
		expect(card.ad).not.toBeNull();
		card.handleNativeEvent({ type: "action", key: "dismiss", act: "dismiss", mods: [] });
		expect(card.ad).toBeNull();
		expect(card.render(60)).toEqual([]);
	});

	it("ignores native actions that are not the dismiss button", () => {
		const card = new PostTaskAdCard();
		const ad = card.ad;
		expect(ad).not.toBeNull();
		card.handleNativeEvent({ type: "action", key: "open", act: "open", mods: [] });
		expect(card.ad).toBe(ad);
		expect(card.render(60).length).toBeGreaterThan(0);
	});
});
