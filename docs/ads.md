# UsingOpen Ads

UsingOpen runs its **own** ad network for the TUI. There is no third-party ad
SDK, no Google, and no tracking beyond the per-install id — the same UUID the
inference gateway already uses (see [install-id.md](install-id.md)). Ads are
decoration: every surface degrades to built-in house ads when the network is
unreachable, and the whole network is one env var away from off.

Advertisers buy these placements through the self-serve portal at
`usingopen.com/advertise`; see [advertise.md](advertise.md) for the dashboard,
budget, and targeting spec. Developers extending the surfaces work from this
document.

## Where ads show

| Surface               | What renders                                                                                             | File                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Welcome tips rotation | ~15% of sessions show an ad in the tip slot instead of a tip, marked `Sponsored by …` / `From UsingOpen` | `packages/tui/src/prompt/welcome.ts`                    |
| Setup splash          | A dim `◆ <sponsor> · <title>` line under the wordmark (native + compact fallback)                        | `packages/tui/src/setup/scenes/splash.ts`               |
| Status-line slot      | An opt-in `ads` segment rendering the latched session ad (`◆ <title>`, or `ads off`)                     | `packages/tui/src/status-line/segments.ts`, `schema.ts` |
| Post-task card        | Freebuff-parity card above the prompt after a turn: `Ad` label, bold title, body, `[ cta ]` button, domain, and a dismiss affordance | `packages/tui/src/ads/post-task-card.ts`     |
| Idle-time card        | A boxed card with caption "While you wait…", body, and CTA; dismiss unmounts it                          | `packages/tui/src/ads/idle-card.ts`                     |
| `/ads` panel          | The current feed with per-ad sponsor, shown counts, and dismissal state                                  | `packages/tui/src/overlays/ads-panel.ts`                |

The footer is the status line in this codebase, so the `ads` segment is the
footer slot; the tips rotation covers the welcome/rotating-copy surface. The
post-task card is the flagship paid placement (Freebuff Terminal parity) and
the one advertisers buy first. Once the shared frequency cap is spent, every
surface — the post-task card included — simply renders nothing, so a session is
never worse than one without ads.

## Configuration

| Variable                                 | Default                     | Meaning                                          |
| ---------------------------------------- | --------------------------- | ------------------------------------------------ |
| `USINGOPEN_ADS`                          | unset (on)                  | `0`/`false`/`off`/`no` disables every ad surface |
| `USINGOPEN_ADS_URL`                      | `https://ads.usingopen.com` | Ad server base (self-hosted or staging)          |
| `USINGOPEN_MODELS_URL`                   | —                           | Unrelated; the model-catalog refresh URL         |
| `USINGOPEN_CONFIG_DIR` / `PI_CONFIG_DIR` | `.usingopen`                | Config root; ads state lives under `<root>/ads/` |

Session-level off: `/ads off` (the panel's `o` key) flips a per-process switch
without touching the env var. Dismissals and show counts persist at
`~/.usingopen/ads/state.json` (mode 0600); the fetched feed is cached at
`~/.usingopen/ads/feed.json` for `ADS_FEED_TTL_MS` (6 h).

## Envelope rules (client-side, not trust-based)

- **Frequency cap**: at most 4 ads per process (`MAX_ADS_PER_SESSION`) and at
  most one per 90 s (`MIN_AD_INTERVAL_MS`), across all surfaces.
- **Dismissal**: a dismissed ad id never returns; the list keeps it visible in
  `/ads` marked `dismissed`.
- **Freshness**: a cached feed older than its TTL is refetched at most once per
  process; a failed refetch keeps the cached (or house) feed.
- **Entitlements**: titles ≤ 60 chars, bodies ≤ 200 chars, https-only URLs,
  `sponsored` ads must name a sponsor; violations drop the entry, not the feed.
  A feed advertising a newer `proto` than the client is refused wholesale.

## Privacy

The only identity sent is the install id, under both the current and legacy
header names during the rollout (`x-usingopen-install-id`, `x-omp-install-id`).
No session ids, prompts, paths, hostnames, or usage telemetry leave the
machine. The OpenTelemetry spans in the agent runtime are unchanged and have no
configured exporter.

## Server contract

```
GET https://ads.usingopen.com/v1/feed
accept: application/json
x-usingopen-install-id: <uuid>
```

```json
{
	"proto": 1,
	"ads": [
		{
			"id": "acme-robotics-2026-10",
			"kind": "sponsored",
			"title": "Ship faster",
			"body": "One or two sentences, at most 200 characters.",
			"cta": "acme.example",
			"url": "https://acme.example",
			"sponsor": "Acme Robotics",
			"weight": 2
		}
	],
	"ttlMs": 21600000
}
```

`kind` is `house` (UsingOpen promos) or `sponsored` (paid placements).
`weight` biases selection (default 1). The response is cached on disk; the
server sees one install-id-attributed fetch per TTL at most.

## House ads

`packages/tui/src/ads/house-ads.ts` ships 8 UsingOpen promos (collab, stream,
stats, skills, mnemo, extensions, auth-gateway, task). They render whenever the
network feed is missing, stale, invalid, or disabled, so a cold host or an
outage never leaves an empty slot.

## Host wiring (coding-agent)

The TUI package ships the model, components, and client; the slash command and
the idle mount are wired by the host (coding-agent) like every other panel:

```ts
// /ads command → open the panel as a focused sheet and bind keys to the model
const model = new AdsPanelModel();
const panel = new AdsPanelComponent(model);
ui.showOverlay(panel); // same path as /usage and friends
onKey("up", () => model.move(-1));
onKey("down", () => model.move(1));
onKey("d", () => model.dismissSelected());
onKey("r", () => void model.refresh());
onKey("o", () => model.toggleEnabled());

// Idle card: mount when a session goes idle, unmount on dismiss
const card = new IdleAdCard(() => unmount(card));
if (card.render(width).length > 0) mount(card);

// Post-task card: mount above the prompt when a turn ends, unmount on dismiss
const postTask = new PostTaskAdCard(() => unmount(postTask));
if (postTask.render(width).length > 0) mountAbovePrompt(postTask);
```

Status-line users opt in with `"ads"` in their segment list
(`statusLine.segments.left/right`).

## Tests

`packages/tui/test/ads/` covers feed parsing (proto, malformed entries, URL
scheme), the env switches, session cap, interval, dismissal, cache adoption,
failure fallbacks, exact header set, card rendering/wrapping, the post-task
card (Ad label, CTA row, narrow-width degradation, dismissal across clients,
native dismiss action), and the panel model. State is isolated with a per-file
`USINGOPEN_CONFIG_DIR`.
