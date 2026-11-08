import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@usingopen/tui";
import { LiveVisualizer } from "@usingopen/tui/apps/live-visualizer";
import { initTheme } from "@usingopen/tui/theme";

describe("LiveVisualizer", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders across the entire provided width even when wider than 120 columns", () => {
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
		});

		for (const targetWidth of [80, 140, 200]) {
			const lines = visualizer.render(targetWidth);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
		}
	});
});
