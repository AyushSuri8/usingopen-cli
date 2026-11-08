import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { pickWeightedTip, WelcomeComponent } from "@usingopen/tui/prompt/welcome";
import { initTheme, theme } from "@usingopen/tui/theme";
import { visibleWidth } from "@usingopen/tui";

describe("WelcomeComponent", () => {
	let savedAds: string | undefined;

	beforeAll(async () => {
		// Ads could occupy the tip slot; pin them off for deterministic tips.
		savedAds = process.env.USINGOPEN_ADS;
		process.env.USINGOPEN_ADS = "0";
		await initTheme(false);
	});

	afterAll(() => {
		if (savedAds === undefined) delete process.env.USINGOPEN_ADS;
		else process.env.USINGOPEN_ADS = savedAds;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("natively sets the version under the wordmark beside the logo", () => {
		const tree = new WelcomeComponent("18.4.12").describe({} as never);
		expect(tree.c?.[0]).toMatchObject({
			key: "lockup",
			p: { role: "usingopen.welcome.lockup" },
			c: [
				{ k: "image", key: "logo" },
				{
					k: "col",
					p: { role: "usingopen.welcome.mark" },
					c: [
						{ p: { role: "usingopen.welcome.wordmark" } },
						{ p: { role: "usingopen.welcome.version", spans: [{ t: "v18.4.12" }] } },
					],
				},
			],
		});
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0");
		expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0");
		expect(welcomeSpecial.tip).toBe("Please use nerdfont 😭.");

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});

	it("centers the lockup and every tip line in the terminal width", () => {
		const columns = 140;
		const rows = new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row).trimEnd());
		const indent = (row: string) => visibleWidth(row) - visibleWidth(row.trimStart());
		const expectCentered = (left: number, right: number) => expect(Math.abs(left - right)).toBeLessThanOrEqual(1);

		// The lockup is one block: the logo's bar starts it, the wordmark row ends it.
		const bar = rows.find(row => row.includes("████████████")) ?? "";
		const word = rows.find(row => row.includes("UsingOpen")) ?? "";
		expectCentered(indent(bar), columns - visibleWidth(word));

		// Each tip line centers on its own.
		const below = rows.slice(rows.findIndex(row => row.includes("Tip: "))).filter(row => row.length > 0);
		expect(below.length).toBeGreaterThanOrEqual(1);
		for (const row of below) expectCentered(indent(row), columns - visibleWidth(row));
	});

	it("drops the tip below 50 columns", () => {
		const text = (columns: number) => Bun.stripANSI(new WelcomeComponent("1.0.0").render(columns).join("\n"));
		expect(text(50)).toContain("Tip: ");
		expect(text(49)).not.toContain("Tip: ");
		expect(text(49)).toContain("v1.0.0");
	});

	it("sets the version under the wordmark while the lockup fits, else keeps the logo alone", () => {
		const rows = (columns: number) => new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row));

		// The lockup needs 12 logo + 4 gap + 9 wordmark columns inside the 2-column margin.
		const fits = rows(27);
		const word = fits.find(row => row.includes("UsingOpen"));
		const version = fits.find(row => row.includes("v1.0.0"));
		expect(fits.some(row => row.includes("████████████"))).toBe(true);
		expect(version?.indexOf("v1.0.0")).toBe(word?.indexOf("UsingOpen"));

		const narrow = rows(26).join("\n");
		expect(narrow).toContain("████████████");
		expect(narrow).not.toContain("UsingOpen");
		expect(narrow).not.toContain("v1.0.0");
	});
});
