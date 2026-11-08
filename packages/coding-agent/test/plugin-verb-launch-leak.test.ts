/**
 * Regression test for #2935 and #4845: the plugins/marketplace docs advertise
 * `usingopen list` / `usingopen remove` / `usingopen marketplace <sub>` / `usingopen uninstall …` etc.
 * as top-level commands, but only `usingopen install` is registered. Before the fix,
 * `resolveCliArgv(["list"])` rewrote the bare verb to `["launch", "list"]`, so
 * `usingopen list` silently started an interactive agent session with "list" as the
 * initial LLM prompt instead of managing plugins (the real command is
 * `usingopen plugin list`). #4845 extended the same footgun to the multi-word
 * documented grammar: `usingopen marketplace add xyz` leaked the whole argv to the
 * model as a prompt.
 *
 * These tests pin the chosen bugfix: a documented plugin/marketplace verb that
 * is bare, or that follows the documented grammar (a marketplace sub-action or a
 * `name@marketplace` plugin id), yields a helpful hint pointing at the real
 * `usingopen plugin <action>` command rather than leaking to the model — while
 * genuine prose prompts that merely begin with one of these words still fall
 * through to `launch`.
 *
 * Imported via a relative path (not the `@usingopen/coding-agent` alias) so the
 * assertions exercise this checkout's `cli-commands.ts` directly.
 */
import { describe, expect, test } from "bun:test";
import { isSubcommand, resolveCliArgv } from "../src/cli-commands";

describe("documented-but-unregistered plugin verbs do not leak to launch (#2935)", () => {
	test("bare `usingopen list` hints at `usingopen plugin list` instead of launching with 'list' as the prompt", () => {
		const result = resolveCliArgv(["list"]);
		// Must NOT be the old silent-launch behavior.
		expect(result).not.toEqual({ argv: ["launch", "list"] });
		expect(result).not.toHaveProperty("argv");
		// Must point at the real command.
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("usingopen plugin list");
	});

	test("bare `usingopen remove` hints at `usingopen plugin uninstall` instead of launching with 'remove' as the prompt", () => {
		const result = resolveCliArgv(["remove"]);
		expect(result).not.toEqual({ argv: ["launch", "remove"] });
		expect(result).not.toHaveProperty("argv");
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("usingopen plugin uninstall");
	});

	test("genuine multi-word prompts beginning with these verbs still route to launch", () => {
		// A real prompt that happens to start with `list`/`remove` must not be hijacked.
		expect(resolveCliArgv(["list", "all", "my", "files"])).toEqual({
			argv: ["launch", "list", "all", "my", "files"],
		});
		expect(resolveCliArgv(["remove", "the", "unused", "import"])).toEqual({
			argv: ["launch", "remove", "the", "unused", "import"],
		});
	});

	test("multi-word `usingopen marketplace add xyz` hints at `usingopen plugin marketplace` instead of leaking to the prompt (#4845)", () => {
		const result = resolveCliArgv(["marketplace", "add", "xyz"]);
		expect(result).not.toEqual({ argv: ["launch", "marketplace", "add", "xyz"] });
		expect(result).not.toHaveProperty("argv");
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("usingopen plugin marketplace");
	});

	test("bare marketplace-family verbs hint at their `usingopen plugin` command (#4845)", () => {
		for (const [verb, hint] of [
			["marketplace", "usingopen plugin marketplace"],
			["discover", "usingopen plugin discover"],
			["upgrade", "usingopen plugin upgrade"],
			["uninstall", "usingopen plugin uninstall"],
			["enable", "usingopen plugin enable"],
			["disable", "usingopen plugin disable"],
		] as const) {
			const result = resolveCliArgv([verb]);
			expect(result).not.toHaveProperty("argv");
			expect("error" in result && result.error).toContain(hint);
		}
	});

	test("`name@marketplace` plugin ids hint instead of launching (#4845)", () => {
		for (const verb of ["uninstall", "upgrade", "enable", "disable"] as const) {
			const result = resolveCliArgv([verb, "code-review@claude-plugins-official"]);
			expect(result).not.toHaveProperty("argv");
			expect(result).toHaveProperty("error");
		}
	});

	test("plugin ids after documented flags hint instead of leaking to launch", () => {
		for (const verb of ["uninstall", "upgrade", "enable", "disable"] as const) {
			const result = resolveCliArgv([verb, "--scope", "project", "code-review@claude-plugins-official"]);
			expect(result).not.toHaveProperty("argv");
			expect(result).toHaveProperty("error");
		}
	});

	test("prose prompts beginning with the new verbs still route to launch (#4845)", () => {
		expect(resolveCliArgv(["upgrade", "the", "deps"])).toEqual({
			argv: ["launch", "upgrade", "the", "deps"],
		});
		// `marketplace` followed by a non-subcommand word is a genuine prompt.
		expect(resolveCliArgv(["marketplace", "research", "for", "me"])).toEqual({
			argv: ["launch", "marketplace", "research", "for", "me"],
		});
	});
});

describe("`usingopen plugins` is a registered alias of `usingopen plugin`", () => {
	// The TUI builtin is `/plugins` while the CLI command is `plugin`. Dispatch
	// resolves `CommandEntry.aliases`, not the command class's `static aliases`,
	// so dropping the registry entry would make `usingopen plugins list` stop reaching
	// the plugin command again.
	test("`usingopen plugins list` routes to the plugin command instead of launch", () => {
		expect(isSubcommand("plugins")).toBe(true);
		expect(resolveCliArgv(["plugins", "list"])).toEqual({ argv: ["plugins", "list"] });
	});

	test("bare `usingopen plugins` routes to the plugin command, which defaults to list", () => {
		expect(resolveCliArgv(["plugins"])).toEqual({ argv: ["plugins"] });
	});
});
