import type { AdAd } from "@usingopen/wire";

/**
 * Fallback ads shown when the network feed is unavailable (cold cache, outage,
 * `USINGOPEN_ADS=0`, or a feed that failed validation). These are UsingOpen's
 * own promos: they cost nothing to serve, need no network, and keep every ad
 * surface honest when the ad server is unreachable.
 */
export const HOUSE_ADS: readonly AdAd[] = [
	{
		id: "house.collab",
		kind: "house",
		title: "Pair up live",
		body: "`/collab` streams your session over an end-to-end encrypted relay — a teammate watches tool calls and prompts your agent from any browser.",
		cta: "usingopen.com/docs/collab",
		url: "https://usingopen.com/docs/collab",
		weight: 2,
	},
	{
		id: "house.stream",
		kind: "house",
		title: "Stream your screen",
		body: "`usingopen stream` shares a live, read-only pane of this terminal — Twitch-style, with chat. Great for demos and debugging together.",
		cta: "usingopen.com/docs/stream",
		url: "https://usingopen.com/docs/stream",
	},
	{
		id: "house.stats",
		kind: "house",
		title: "Know your burn",
		body: "`usingopen stats` renders a local dashboard of every token, cost, and cache hit this install has spent. Nothing leaves the machine.",
		cta: "usingopen.com/docs/user-facing-packages",
		url: "https://usingopen.com/docs/user-facing-packages",
		weight: 2,
	},
	{
		id: "house.skills",
		kind: "house",
		title: "Ship a skill",
		body: "Skills are plain markdown folders. Publish one to the UsingOpen skillshare registry and install it anywhere with a single command.",
		cta: "usingopen.com/docs/skills",
		url: "https://usingopen.com/docs/skills",
	},
	{
		id: "house.mnemo",
		kind: "house",
		title: "Remember everything",
		body: "Mnemo keeps a local, searchable memory of what your agent learned — worktrees, decisions, and dead ends — across sessions.",
		cta: "usingopen.com/docs/mnemo",
		url: "https://usingopen.com/docs/mnemo",
	},
	{
		id: "house.extensions",
		kind: "house",
		title: "Extend the agent",
		body: "Extensions add tools, commands, and hooks in TypeScript. Install them per-project or globally from npm or a local folder.",
		cta: "usingopen.com/docs/extensions",
		url: "https://usingopen.com/docs/extensions",
	},
	{
		id: "house.gateway",
		kind: "house",
		title: "One gateway, every client",
		body: "`usingopen auth-gateway` fronts your accounts as a drop-in OpenAI-compatible proxy — your editor, your scripts, one set of keys.",
		cta: "usingopen.com/docs/auth-broker-gateway",
		url: "https://usingopen.com/docs/auth-broker-gateway",
	},
	{
		id: "house.tan",
		kind: "house",
		title: "Fork the conversation",
		body: "`/tan` spins the current session into a background subagent so a side quest never blocks the main line of work.",
		url: "https://usingopen.com/docs/tools/task.md",
	},
];
