/**
 * Log in to a model provider from the terminal.
 */

import { APP_NAME } from "@usingopen/utils";
import { Args, Command, Flags } from "@usingopen/utils/cli";
import { loginHelp as commandHelp } from "../cli/command-help";
import { runLoginCommand } from "../cli/login-cli";

export default class Login extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "OAuth provider id (e.g. anthropic, openai-codex); omit to pick interactively",
			required: false,
		}),
	};

	static flags = {
		device: Flags.boolean({
			description: "Use the device-code flow instead of the browser redirect (UsingOpen: WorkOS CLI Auth)",
		}),
	};

	static examples = [
		`# Pick a provider interactively\n  ${APP_NAME} login`,
		`# Log in to a specific provider\n  ${APP_NAME} login anthropic`,
		`# Device-code sign-in when no browser can reach this machine\n  ${APP_NAME} login usingopen --device`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Login);
		await runLoginCommand(args.provider, { device: flags.device });
	}
}
