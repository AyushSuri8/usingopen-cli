/**
 * `usingopen login [provider]` — the terminal counterpart of the in-session `/login`.
 *
 * Authenticates against the same credential store sessions read (local
 * `agent.db`, or the configured auth broker), including OAuth providers
 * contributed by extensions, then re-runs that provider's model discovery so
 * the next session sees the models the credential unlocked.
 */
import * as readline from "node:readline";
import { getOAuthProviders, type OAuthProviderInfo } from "@usingopen/ai";
import { APP_NAME, getAgentDbPath, getProjectDir } from "@usingopen/utils";
import chalk from "@usingopen/utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { formatLoginIdentity, pickOAuthProvider, runTerminalOAuthLogin } from "./oauth-terminal";

/** Login id of the UsingOpen device-code flow (`--device` with no provider). */
const DEFAULT_DEVICE_LOGIN = "usingopen-device";
/** Login ids that run a provider's device-code variant: `<id>-device` aliases. */
const deviceLoginId = (providerId: string): string => `${providerId}-device`;

/**
 * Resolve `--device` to a login id.
 *
 * With an explicit provider, the `-device` login alias it declares is used
 * (e.g. `openai-codex --device` ⇒ `openai-codex-device`); without one, the
 * UsingOpen WorkOS CLI Auth device flow runs. Aliases store their grant
 * under the provider they authenticate, so discovery refresh below still
 * targets the right provider.
 */
function resolveDeviceLoginId(provider: string | undefined, providers: readonly OAuthProviderInfo[]): string {
	if (!provider) return DEFAULT_DEVICE_LOGIN;
	const deviceId = deviceLoginId(provider);
	if (providers.some(p => p.id === deviceId)) return deviceId;
	const supported = providers
		.filter(p => providers.some(d => d.id === deviceLoginId(p.id)))
		.map(p => p.id)
		.join(", ");
	throw new Error(
		`--device is not available for '${provider}'${supported ? `; supported providers: ${supported}` : ""}`,
	);
}

/**
 * Log in to `provider`, or to one picked interactively when omitted.
 *
 * `--device` runs the device-code flow instead of the browser redirect
 * (WorkOS CLI Auth for UsingOpen) for providers that declare one.
 *
 * An unknown/unavailable provider, a cancelled selection or prompt, and a
 * failed OAuth flow print `Login failed: …` to stderr and set exit code 1.
 */
export async function runLoginCommand(provider: string | undefined, options: { device?: boolean } = {}): Promise<void> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		// Extensions may register OAuth providers; load them so they are listed.
		await loadCliExtensionProviders(modelRegistry, settings, cwd);

		const providers = getOAuthProviders().filter(p => p.available);
		const providerId = options.device
			? resolveDeviceLoginId(provider, providers)
			: (provider ?? (await pickOAuthProvider(rl, providers)));
		const info = providers.find(p => p.id === providerId);
		if (!info) {
			throw new Error(`Unknown OAuth provider '${providerId}'. Run \`${APP_NAME} login\` to pick one.`);
		}

		const identity = await runTerminalOAuthLogin(rl, authStorage, info.id, { openBrowser: true });
		if (!identity) {
			process.stdout.write(chalk.yellow(`No credentials were stored for ${info.name}.\n`));
			return;
		}
		// A provider-scoped online refresh re-runs discovery with the new
		// credential; a fresh cache row fetched before login would otherwise hide
		// the unlocked models until its TTL expires (#5780).
		await modelRegistry.refreshProvider(info.storeCredentialsAs ?? info.id, "online");

		const who = formatLoginIdentity(identity);
		process.stdout.write(chalk.green(`\nLogged in to ${info.name}${who ? ` as ${who}` : ""}\n`));
		const broker = await resolveAuthBrokerConfig();
		process.stdout.write(
			chalk.dim(
				broker ? `Credentials saved to auth broker ${broker.url}\n` : `Credentials saved to ${getAgentDbPath()}\n`,
			),
		);
	} catch (error) {
		process.stderr.write(chalk.red(`Login failed: ${error instanceof Error ? error.message : String(error)}\n`));
		process.exitCode = 1;
	} finally {
		rl.close();
		authStorage.close();
	}
}
