import { describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "../src/registry/registry";
import type { OAuthController, OAuthCredentials } from "../src/registry/oauth/types";
import type { FetchImpl } from "../src/types";

/**
 * WorkOS AuthKit wiring for the UsingOpen identity (`auth/usingopen.kdl`,
 * `auth/usingopen-device.kdl`): the public client id comes from the
 * environment, the browser flow is PKCE-only against AuthKit's authorize
 * endpoint, the device flow follows the WorkOS CLI Auth polling contract,
 * and every response carries a rotated refresh token the store must adopt.
 */
const CLIENT_ID = "client_01TESTUSINGOPEN";
const CLIENT_ID_ENV = "USINGOPEN_CLIENT_ID";
const AUTHORIZE_URL = "https://api.workos.com/user_management/authorize";
const DEVICE_URL = "https://api.workos.com/user_management/authorize/device";
const TOKEN_URL = "https://api.workos.com/user_management/authenticate";

function makeJwt(claims: Record<string, unknown>): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** WorkOS `user_management/authenticate` payload: rotated grant plus the AuthKit user object. */
function workosTokens(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		access_token: makeJwt({
			sub: "user_1",
			email: "dev@usingopen.com",
			exp: Math.floor(Date.now() / 1000) + 3600,
		}),
		refresh_token: "refresh-rotated",
		user: { object: "user", id: "user_1", email: "dev@usingopen.com", email_verified: true },
		organization_id: "org_1",
		authentication_method: "GoogleOAuth",
		...overrides,
	};
}

function restoreClientId(previous: string | undefined): void {
	if (previous === undefined) delete process.env[CLIENT_ID_ENV];
	else process.env[CLIENT_ID_ENV] = previous;
}

function withClientId<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.env[CLIENT_ID_ENV];
	process.env[CLIENT_ID_ENV] = CLIENT_ID;
	return run().finally(() => restoreClientId(previous));
}

async function loginBrowser(ctrl: OAuthController): Promise<OAuthCredentials> {
	const result = await getProviderDefinition("usingopen")?.login?.(ctrl);
	if (!result || typeof result === "string") throw new Error("UsingOpen browser login is unavailable");
	return result;
}

async function loginDevice(ctrl: OAuthController): Promise<OAuthCredentials> {
	const result = await getProviderDefinition("usingopen-device")?.login?.(ctrl);
	if (!result || typeof result === "string") throw new Error("UsingOpen device login is unavailable");
	return result;
}

async function refreshStored(refreshToken: string, fetchImpl: FetchImpl): Promise<OAuthCredentials> {
	// The refresh engine posts through the global fetch (no controller).
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign((input: string | URL | Request, init?: RequestInit) => fetchImpl(input, init), {
			preconnect: fetch.preconnect,
		}),
	);
	try {
		const refresh = getProviderDefinition("usingopen")?.refreshToken;
		if (!refresh) throw new Error("UsingOpen refresh is unavailable");
		return await refresh({ access: "stale", refresh: refreshToken, expires: 0 }, undefined);
	} finally {
		fetchSpy.mockRestore();
	}
}

describe("UsingOpen WorkOS browser login (PKCE default)", () => {
	it("authorizes through AuthKit with PKCE and exchanges the code with the verifier", async () => {
		await withClientId(async () => {
			let authUrl = "";
			const requests: Array<{ url: string; body: string }> = [];
			const fetchImpl: FetchImpl = async (input, init) => {
				requests.push({ url: String(input), body: String(init?.body ?? "") });
				return jsonResponse(workosTokens());
			};

			const credentials = await loginBrowser({
				onAuth: info => {
					authUrl = info.url;
				},
				onManualCodeInput: async () => "workos-code-123",
				fetch: fetchImpl,
			});

			const parsed = new URL(authUrl);
			expect(parsed.origin + parsed.pathname).toBe(AUTHORIZE_URL);
			// AuthKit (not SSO) handles the hosted flow; no connection selector exists on the free tier.
			expect(parsed.searchParams.get("provider")).toBe("authkit");
			expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
			expect(parsed.searchParams.get("response_type")).toBe("code");
			expect(parsed.searchParams.get("scope")).toBe("openid profile email offline_access");
			expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
			expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54551/callback");

			const exchange = requests.find(request => request.url === TOKEN_URL);
			expect(requests.map(request => request.url)).toEqual([TOKEN_URL]);
			const body = new URLSearchParams(exchange?.body ?? "");
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("workos-code-123");
			expect(body.get("client_id")).toBe(CLIENT_ID);
			// A public client never ships a secret; the S256 verifier is the proof.
			expect(body.has("client_secret")).toBe(false);
			const verifier = body.get("code_verifier") ?? "";
			const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
			expect(parsed.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));

			expect(credentials).toMatchObject({
				refresh: "refresh-rotated",
				email: "dev@usingopen.com",
				accountId: "user_1",
			});
		});
	});

	it("fails the login with a configuration error when the client id env var is unset", async () => {
		const previous = process.env[CLIENT_ID_ENV];
		delete process.env[CLIENT_ID_ENV];
		try {
			let fetchCalls = 0;
			const fetchImpl: FetchImpl = async () => {
				fetchCalls += 1;
				return jsonResponse(workosTokens());
			};
			await expect(
				loginBrowser({ onAuth: () => {}, onManualCodeInput: async () => "code", fetch: fetchImpl }),
			).rejects.toThrow(CLIENT_ID_ENV);
			// The failure happens before any WorkOS request is made.
			expect(fetchCalls).toBe(0);
		} finally {
			restoreClientId(previous);
		}
	});
});

describe("UsingOpen WorkOS device login (CLI Auth fallback)", () => {
	it("polls the token endpoint after one pending response and maps the user payload", async () => {
		await withClientId(async () => {
			const requests: Array<{ url: string; body: string }> = [];
			let tokenPolls = 0;
			const fetchImpl: FetchImpl = async (input, init) => {
				const url = String(input);
				requests.push({ url, body: String(init?.body ?? "") });
				if (url === DEVICE_URL) {
					return jsonResponse({
						device_code: "device-secret",
						user_code: "RRGQ-BJVS",
						verification_uri: "https://authkit.usingopen.com/device",
						verification_uri_complete: "https://authkit.usingopen.com/device?user_code=RRGQ-BJVS",
						expires_in: 300,
						interval: 0.05,
					});
				}
				tokenPolls += 1;
				// First poll: RFC 8628 authorization_pending; second: the grant.
				return tokenPolls === 1
					? jsonResponse({ error: "authorization_pending" }, 400)
					: jsonResponse(workosTokens());
			};

			let authUrl = "";
			let instructions = "";
			const credentials = await loginDevice({
				onAuth: info => {
					authUrl = info.url;
					instructions = info.instructions ?? "";
				},
				fetch: fetchImpl,
			});

			expect(authUrl).toBe("https://authkit.usingopen.com/device?user_code=RRGQ-BJVS");
			expect(instructions).toContain("RRGQ-BJVS");
			const deviceRequest = requests.find(request => request.url === DEVICE_URL);
			expect(new URLSearchParams(deviceRequest?.body ?? "").get("client_id")).toBe(CLIENT_ID);
			const polls = requests.filter(request => request.url === TOKEN_URL);
			expect(polls).toHaveLength(2);
			for (const poll of polls) {
				const body = new URLSearchParams(poll.body);
				expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(body.get("device_code")).toBe("device-secret");
				expect(body.get("client_id")).toBe(CLIENT_ID);
			}
			// The completed poll returns the rotated grant and the AuthKit user.
			expect(credentials).toMatchObject({
				refresh: "refresh-rotated",
				email: "dev@usingopen.com",
				accountId: "user_1",
			});
			expect(credentials.expires).toBeGreaterThan(Date.now());
		});
	});

	it("fails fast when WorkOS reports the device code expired", async () => {
		await withClientId(async () => {
			const fetchImpl: FetchImpl = async input =>
				String(input) === DEVICE_URL
					? jsonResponse({
							device_code: "device-secret",
							user_code: "RRGQ-BJVS",
							verification_uri: "https://authkit.usingopen.com/device",
							verification_uri_complete: "https://authkit.usingopen.com/device?user_code=RRGQ-BJVS",
							expires_in: 300,
							interval: 5,
						})
					: jsonResponse({ error: "expired_token" }, 400);

			await expect(loginDevice({ onAuth: () => {}, fetch: fetchImpl })).rejects.toThrow(/expired/i);
		});
	});
});

describe("UsingOpen WorkOS refresh rotation", () => {
	it("replaces the stored refresh token with the rotated one and re-reads identity", async () => {
		await withClientId(async () => {
			const requests: Array<{ url: string; body: string }> = [];
			const fetchImpl: FetchImpl = async (input, init) => {
				requests.push({ url: String(input), body: String(init?.body ?? "") });
				return jsonResponse(workosTokens({ user: { id: "user_1", email: "rotated@usingopen.com" } }));
			};

			const credentials = await refreshStored("refresh-old", fetchImpl);

			expect(requests).toHaveLength(1);
			expect(requests[0]?.url).toBe(TOKEN_URL);
			const body = new URLSearchParams(requests[0]?.body ?? "");
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("refresh-old");
			expect(body.get("client_id")).toBe(CLIENT_ID);
			expect(body.has("client_secret")).toBe(false);
			expect(credentials.refresh).toBe("refresh-rotated");
			expect(credentials.email).toBe("rotated@usingopen.com");
		});
	});

	it("surfaces invalid_grant as a login-required failure instead of retrying", async () => {
		await withClientId(async () => {
			let calls = 0;
			const fetchImpl: FetchImpl = async () => {
				calls += 1;
				return jsonResponse({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
			};

			await expect(refreshStored("refresh-revoked", fetchImpl)).rejects.toThrow(/400/);
			expect(calls).toBe(1);
		});
	});
});
