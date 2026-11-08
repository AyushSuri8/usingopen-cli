/**
 * UsingOpen identity via WorkOS AuthKit — the public client id both login
 * flows (`auth/usingopen.kdl` PKCE default, `auth/usingopen-device.kdl`
 * device fallback) authenticate with. The client id is not baked into the
 * CLI: it resolves from the environment so the AuthKit application can be
 * rotated or re-pointed per environment without a client release. A missing
 * value fails the login with a configuration error instead of letting
 * WorkOS reject an empty `client_id` with an opaque 400.
 */

import { $env } from "@usingopen/utils";
import * as AIError from "../../error";
import type { ValueHook } from "../hooks/types";

const CLIENT_ID_ENV = "USINGOPEN_CLIENT_ID";

export const usingOpenClientId: ValueHook = async () => {
	const clientId = $env[CLIENT_ID_ENV]?.trim();
	if (!clientId) {
		throw new AIError.ConfigurationError(
			`UsingOpen sign-in needs a WorkOS client id: set ${CLIENT_ID_ENV} (see docs/auth-workos.md)`,
		);
	}
	return clientId;
};
