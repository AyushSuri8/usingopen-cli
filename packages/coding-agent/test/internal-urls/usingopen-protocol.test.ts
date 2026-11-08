import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@usingopen/coding-agent/internal-urls";

describe("UsingopenProtocolHandler", () => {
	it("treats usingopen://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("usingopen://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("usingopen://tools/read.md");
		const prefixed = await router.resolve("usingopen://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
