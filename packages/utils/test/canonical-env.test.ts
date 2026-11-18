import { describe, expect, it } from "bun:test";
import { getAgentDirOverrideEnv } from "@usingopen/utils/dirs";
import { timingModeIncludes } from "@usingopen/utils/logger";

describe("canonical USINGOPEN_ env spellings", () => {
	it("prefers USINGOPEN_CODING_AGENT_DIR over the legacy PI_ name", () => {
		expect(getAgentDirOverrideEnv({ USINGOPEN_CODING_AGENT_DIR: "/canonical", PI_CODING_AGENT_DIR: "/legacy" })).toBe(
			"/canonical",
		);
	});

	it("falls back to PI_CODING_AGENT_DIR when the canonical name is unset", () => {
		expect(getAgentDirOverrideEnv({ PI_CODING_AGENT_DIR: "/legacy" })).toBe("/legacy");
		expect(getAgentDirOverrideEnv({})).toBeUndefined();
	});

	it("accepts USINGOPEN_TIMING and keeps PI_TIMING as an alias", () => {
		const originalCanonical = process.env.USINGOPEN_TIMING;
		const originalLegacy = process.env.PI_TIMING;
		try {
			delete process.env.USINGOPEN_TIMING;
			process.env.PI_TIMING = "x";
			expect(timingModeIncludes("x")).toBe(true);

			process.env.USINGOPEN_TIMING = "full";
			expect(timingModeIncludes("full")).toBe(true);
			expect(timingModeIncludes("x")).toBe(false);
		} finally {
			if (originalCanonical === undefined) delete process.env.USINGOPEN_TIMING;
			else process.env.USINGOPEN_TIMING = originalCanonical;
			if (originalLegacy === undefined) delete process.env.PI_TIMING;
			else process.env.PI_TIMING = originalLegacy;
		}
	});
});
