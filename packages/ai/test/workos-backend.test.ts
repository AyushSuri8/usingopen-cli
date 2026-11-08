import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkosApiKey, WorkOSBackend } from "../src/auth/workos-backend";

/**
 * Backend-side WorkOS wiring: the API key comes from a single 0600 file, token
 * verification is JWKS/RS256 with issuer binding, reads and grants go through
 * api.workos.com with the key as bearer (and as the client secret of this
 * first-party app), and ad beacons authenticate with install-id attribution.
 * All requests are hermetic: `baseUrl` points at a test host and fetch is
 * injected, so nothing here reaches the staging environment.
 */
const CLIENT_ID = "client_01TESTBACKEND";
const API_BASE_URL = "https://api.workos.test";
const API_KEY = "sk_test_backend_key_never_printed";
const KID = "sso_oidc_key_pair_01TEST";

function base64Url(value: object | string): string {
	const raw = typeof value === "string" ? value : JSON.stringify(value);
	return Buffer.from(raw).toString("base64url");
}

async function rsaPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
}

async function signJwt(
	privateKey: CryptoKey,
	claims: Record<string, unknown>,
	header: Record<string, unknown> = {},
): Promise<string> {
	const head = base64Url({ alg: "RS256", typ: "JWT", kid: KID, ...header });
	const body = base64Url(claims);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(`${head}.${body}`),
	);
	return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface CapturedRequest {
	url: string;
	method: string;
	authorization: string | undefined;
	headers: Record<string, string>;
	body: string;
}

function fakeFetch(routes: Record<string, () => Response>, captured: CapturedRequest[]): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			captured.push({
				url,
				method: init?.method ?? "GET",
				authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
				headers: (init?.headers as Record<string, string> | undefined) ?? {},
				body: String(init?.body ?? ""),
			});
			const route = routes[url];
			if (!route) return jsonResponse({ message: `no route for ${url}` }, 404);
			return route();
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
}

const GRANT_CLAIMS = {
	iss: `${API_BASE_URL}/user_management/${CLIENT_ID}`,
	sub: "user_01TESTUSER",
	sid: "session_01TEST",
	iat: Math.floor(Date.now() / 1000) - 10,
	exp: Math.floor(Date.now() / 1000) + 300,
};

describe("loadWorkosApiKey", () => {
	it("reads and trims the key from the given file, and nothing else", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workos-key-"));
		try {
			const file = path.join(dir, "workos_staging.key");
			await fs.writeFile(file, `  ${API_KEY}\n`, { mode: 0o600 });
			expect(await loadWorkosApiKey(file)).toBe(API_KEY);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("fails with a configuration error naming the path when the file is missing or empty", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workos-key-"));
		try {
			const missing = path.join(dir, "absent.key");
			await expect(loadWorkosApiKey(missing)).rejects.toThrow(missing);
			const empty = path.join(dir, "empty.key");
			await fs.writeFile(empty, "   \n", { mode: 0o600 });
			await expect(loadWorkosApiKey(empty)).rejects.toThrow(empty);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("WorkOSBackend.verifyAccessToken", () => {
	const setup = async () => {
		const pair = await rsaPair();
		const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
		const jwks = { keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] };
		const captured: CapturedRequest[] = [];
		const fetchImpl = fakeFetch({ [`${API_BASE_URL}/sso/jwks/${CLIENT_ID}`]: () => jsonResponse(jwks) }, captured);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		return { pair, captured, backend };
	};

	it("accepts a correctly signed RS256 token and returns its claims", async () => {
		const { pair, backend } = await setup();
		const token = await signJwt(pair.privateKey, GRANT_CLAIMS);
		const claims = await backend.verifyAccessToken(token, CLIENT_ID);
		expect(claims).toMatchObject({ userId: "user_01TESTUSER", sessionId: "session_01TEST" });
		expect(claims.expiresAtMs).toBe(GRANT_CLAIMS.exp * 1000);
	});

	it("fetches the client's JWKS with the API key and caches it for the next verify", async () => {
		const { pair, captured, backend } = await setup();
		const token = await signJwt(pair.privateKey, GRANT_CLAIMS);
		await backend.verifyAccessToken(token, CLIENT_ID);
		await backend.verifyAccessToken(token, CLIENT_ID);
		const jwksRequests = captured.filter(request => request.url.endsWith(`/sso/jwks/${CLIENT_ID}`));
		expect(jwksRequests).toHaveLength(1);
		expect(jwksRequests[0]?.authorization).toBe(`Bearer ${API_KEY}`);
	});

	it("rejects a tampered signature, a foreign issuer, an expired token, and a non-RS256 alg", async () => {
		const { pair, backend } = await setup();
		const token = await signJwt(pair.privateKey, GRANT_CLAIMS);
		const [head, body, signature] = token.split(".") as [string, string, string];
		const tampered = `${head}.${body}.${signature.slice(0, -4)}AAAA`;
		await expect(backend.verifyAccessToken(tampered, CLIENT_ID)).rejects.toThrow(/signature/i);

		const foreignIssuer = await signJwt(pair.privateKey, { ...GRANT_CLAIMS, iss: "https://evil.example" });
		await expect(backend.verifyAccessToken(foreignIssuer, CLIENT_ID)).rejects.toThrow(/issuer/i);

		const expired = await signJwt(pair.privateKey, { ...GRANT_CLAIMS, exp: Math.floor(Date.now() / 1000) - 60 });
		await expect(backend.verifyAccessToken(expired, CLIENT_ID)).rejects.toThrow(/expired/i);

		const hs256 = await signJwt(pair.privateKey, GRANT_CLAIMS, { alg: "HS256" });
		await expect(backend.verifyAccessToken(hs256, CLIENT_ID)).rejects.toThrow(/RS256/i);

		await expect(backend.verifyAccessToken("not-a-jwt", CLIENT_ID)).rejects.toThrow(/JWT/i);
	});
});

describe("WorkOSBackend reads", () => {
	it("reads a user by id with the API key and projects identity fields", async () => {
		const captured: CapturedRequest[] = [];
		const fetchImpl = fakeFetch(
			{
				[`${API_BASE_URL}/user_management/users/user_01TESTUSER`]: () =>
					jsonResponse({
						object: "user",
						id: "user_01TESTUSER",
						email: "dev@usingopen.com",
						email_verified: true,
					}),
			},
			captured,
		);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		const user = await backend.readUser("user_01TESTUSER");
		expect(user).toEqual({ id: "user_01TESTUSER", email: "dev@usingopen.com", emailVerified: true });
		expect(captured[0]?.authorization).toBe(`Bearer ${API_KEY}`);
	});

	it("surfaces non-2xx reads as OAuth errors carrying the status", async () => {
		const fetchImpl = fakeFetch(
			{
				[`${API_BASE_URL}/user_management/users/user_missing`]: () =>
					jsonResponse({ message: "User not found" }, 404),
			},
			[],
		);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		await expect(backend.readUser("user_missing")).rejects.toThrow(/404/);
	});

	it("reads an organization by id from the platform organizations route", async () => {
		const captured: CapturedRequest[] = [];
		const fetchImpl = fakeFetch(
			{
				[`${API_BASE_URL}/organizations/org_01TEST`]: () =>
					jsonResponse({ object: "organization", id: "org_01TEST", name: "UsingOpen" }),
			},
			captured,
		);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		expect(await backend.readOrganization("org_01TEST")).toEqual({ id: "org_01TEST", name: "UsingOpen" });
		expect(captured[0]?.url).toBe(`${API_BASE_URL}/organizations/org_01TEST`);
	});

	it("lists users and organizations, mapping only well-formed rows", async () => {
		const captured: CapturedRequest[] = [];
		const fetchImpl = fakeFetch(
			{
				[`${API_BASE_URL}/user_management/users?limit=2`]: () =>
					jsonResponse({
						object: "list",
						data: [
							{ id: "user_a", email: "a@usingopen.com", email_verified: true },
							{ id: "user_b" },
							{ email: "broken@usingopen.com" },
						],
					}),
				[`${API_BASE_URL}/organizations?limit=2`]: () =>
					jsonResponse({ object: "list", data: [{ id: "org_a", name: "Org A" }, { name: "no-id" }] }),
			},
			captured,
		);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		expect(await backend.listUsers(2)).toEqual([
			{ id: "user_a", email: "a@usingopen.com", emailVerified: true },
			{ id: "user_b", email: undefined, emailVerified: false },
		]);
		expect(await backend.listOrganizations(2)).toEqual([{ id: "org_a", name: "Org A" }]);
		expect(captured.map(request => request.url)).toEqual([
			`${API_BASE_URL}/user_management/users?limit=2`,
			`${API_BASE_URL}/organizations?limit=2`,
		]);
	});
});

describe("WorkOSBackend token grants", () => {
	const grantResponseBody = (overrides: Record<string, unknown> = {}) => ({
		access_token: "access-new",
		refresh_token: "refresh-new",
		user: { id: "user_01TESTUSER", email: "dev@usingopen.com", email_verified: true },
		...overrides,
	});

	it("exchanges a refresh token, sending the API key as the client secret", async () => {
		const captured: CapturedRequest[] = [];
		const fetchImpl = fakeFetch(
			{ [`${API_BASE_URL}/user_management/authenticate`]: () => jsonResponse(grantResponseBody()) },
			captured,
		);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		const grant = await backend.refreshTokenGrant(CLIENT_ID, "refresh-old");
		const params = new URLSearchParams(captured[0]?.body ?? "");
		expect(params.get("grant_type")).toBe("refresh_token");
		expect(params.get("refresh_token")).toBe("refresh-old");
		expect(params.get("client_id")).toBe(CLIENT_ID);
		expect(params.get("client_secret")).toBe(API_KEY);
		expect(grant).toEqual({
			accessToken: "access-new",
			refreshToken: "refresh-new",
			user: { id: "user_01TESTUSER", email: "dev@usingopen.com", emailVerified: true },
		});
	});

	it("mints tokens headlessly with email+password for admin flows", async () => {
		const captured: CapturedRequest[] = [];
		const fetchImpl = fakeFetch(
			{ [`${API_BASE_URL}/user_management/authenticate`]: () => jsonResponse(grantResponseBody()) },
			captured,
		);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		const grant = await backend.authenticateWithPassword(CLIENT_ID, "dev@usingopen.com", "pw");
		const params = new URLSearchParams(captured[0]?.body ?? "");
		expect(params.get("grant_type")).toBe("password");
		expect(params.get("email")).toBe("dev@usingopen.com");
		expect(grant.accessToken).toBe("access-new");
	});

	it("fails the grant with the WorkOS status when the refresh token is rejected", async () => {
		const fetchImpl = fakeFetch(
			{ [`${API_BASE_URL}/user_management/authenticate`]: () => jsonResponse({ error: "invalid_grant" }, 400) },
			[],
		);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		await expect(backend.refreshTokenGrant(CLIENT_ID, "refresh-revoked")).rejects.toThrow(/400/);
	});
});

describe("WorkOSBackend.authenticateAdsBeacon", () => {
	it("posts the impression with install-id attribution headers and the API-key bearer", async () => {
		const captured: CapturedRequest[] = [];
		const fetchImpl = fakeFetch(
			{ "https://ads.usingopen.test/v1/impression": () => jsonResponse({ ok: true }, 202) },
			captured,
		);
		const backend = new WorkOSBackend({ apiKey: API_KEY, baseUrl: API_BASE_URL, fetch: fetchImpl });
		const result = await backend.authenticateAdsBeacon({
			installId: "8019fce4-6f01-4f2e-9684-7635173366f0",
			adId: "house.collab",
			adsBaseUrl: "https://ads.usingopen.test",
		});
		expect(result).toEqual({ status: 202, ok: true, body: { ok: true } });
		const request = captured[0];
		expect(request?.url).toBe("https://ads.usingopen.test/v1/impression");
		expect(request?.method).toBe("POST");
		expect(JSON.parse(request?.body ?? "{}")).toEqual({ adId: "house.collab" });
		expect(request?.authorization).toBe(`Bearer ${API_KEY}`);
		// Only the install id leaves the machine, under both attribution header names.
		expect(request?.headers["x-usingopen-install-id"]).toBe("8019fce4-6f01-4f2e-9684-7635173366f0");
		expect(request?.headers["x-omp-install-id"]).toBe("8019fce4-6f01-4f2e-9684-7635173366f0");
	});
});
