import { getOAuthProviders as rootGetOAuthProviders, refreshOAuthToken as rootRefreshOAuthToken } from "@usingopen/ai";
import {
	getOAuthProviders as oauthGetOAuthProviders,
	refreshOAuthToken as oauthRefreshOAuthToken,
} from "@usingopen/ai/registry/oauth";
import "@usingopen/ai/providers/anthropic";
import "@usingopen/ai/auth-storage";

const publicExports = [rootGetOAuthProviders, rootRefreshOAuthToken, oauthGetOAuthProviders, oauthRefreshOAuthToken];

if (publicExports.some(value => !value)) {
	throw new Error("OAuth registry exports are unavailable");
}
