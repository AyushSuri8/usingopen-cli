# UsingOpen Advertise — spec

Specification for `/advertise`, the self-serve portal at
`usingopen.com/advertise` where advertisers buy placements on the UsingOpen ad
network — the same network that fills the TUI surfaces described in
[ads.md](ads.md). The network is UsingOpen-owned end to end: no third-party ad
SDK, no Google, no cross-site profiles. The only identity a client ever sends
is the per-install id, and only on actions the user can see (an ad rendering, a
CTA click).

## Placements

| Placement            | Where it renders                                                     | Bought as             |
| -------------------- | -------------------------------------------------------------------- | --------------------- |
| **Post-task card**   | Above the prompt once a turn ends: `Ad` label, bold title, body, CTA button + domain, dismiss | `post-task` (primary) |
| Welcome tip slot     | ~15% of welcome banners, `Sponsored by …`                            | `welcome`             |
| Setup splash line    | Dim sponsor line under the wordmark during setup                     | `splash`              |
| Status-line slot     | Opt-in `ads` footer segment                                          | `status`              |
| Idle-time card       | Boxed card while the session waits on the user                       | `idle`                |
| `/ads` panel listing | Feed listing with dismiss state                                      | `panel`               |

Creative validation is shared with the client: titles ≤ 60 characters, bodies
≤ 200, https-only URLs, and a named sponsor for every paid placement. A
creative that violates an envelope rule is rejected at upload, never silently
dropped at serve time.

## The $500 credit hook

Every new advertiser account is granted a **$500 starter credit**, exactly
once, on the first campaign creation. The credit hook has three observable
events and one hard rule:

- `advertise.credit.granted` — fired when the $500 lands; the dashboard shows
  it as the account's opening balance with no card attached.
- `advertise.credit.exhausted` — fired when delivery spends the credit to
  zero. Campaigns **auto-pause**; nothing hard-fails and no card is charged
  without credit.
- `advertise.credit.topped-up` — fired when the advertiser adds funds; paused
  campaigns resume at the next feed revision.

The hard rule: **spend draws from credit before any payment method**, credit is
non-transferable, has no cash value, and can only be consumed by delivery.
House ads (UsingOpen's own promos) never touch these balances.

## Campaigns

A campaign is a budget, a targeting selection, and one or more creatives.

- **States**: `draft` → `active` → `paused` ⇄ `active`, with `exhausted`
  (daily budget spent) and `ended` as terminal-ish states reached
  automatically.
- **Pause** is immediate on the dashboard: the campaign stops entering the
  feed at the next revision (the feed's TTL is 6 h; the dashboard can force a
  revision to drop a creative sooner). A paused campaign keeps its budget,
  its history, and its creative.
- **Daily budget** caps spend per UTC day. Delivery paces evenly across the
  day rather than burning the budget in the first hour. When the cap is hit,
  the creative stops entering the feed until the next UTC boundary and the slot
  falls through to the next eligible campaign — or to house ads, so a slot is
  never empty.
- **Pricing** is pay-per-click: `spend = clicks × bid`. Impressions are the
  rotation a creative earns while it competes; they are reported but not
  billed. CPM buying lands after launch.

## Dashboard metrics

The dashboard reports, per campaign and per creative, over selectable ranges
(day / 7 d / 30 d / all):

| Metric        | Definition                                            | How it is collected                                             |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Impressions   | Times the card actually rendered on screen            | The client beacons `POST /v1/impression` when the card mounts — not on feed fetch |
| Clicks        | CTA activations                                       | The CTA runs through `GET /v1/click?ad=<id>&to=<url>`, which records and 302s to the advertiser's landing page |
| Conversions   | Signups, installs, purchases on the advertiser's site | The advertiser's landing page calls `POST /v1/conversion` (or their own analytics) |
| Spend         | Billed clicks                                         | `clicks × bid`, summed against the daily budget and credit       |
| CTR / CPC     | Derived ratios                                        | `clicks / impressions`, `spend / clicks`                         |

Because pricing is per click, an impression and a click are the same
install-id-attributed record family: `{ adId, installId, ts }` and nothing
else. No session ids, prompts, paths, hostnames, or usage telemetry are
collected or accepted — a beacon carrying anything beyond ad id and install id
is rejected.

## Devtool targeting

Advertisers select **which developer tools their product competes beside**,
plus which placements it competes on. The taxonomy is advertiser-declared and
reviewed at upload (a CI product cannot buy the `databases` vertical):

- **Verticals**: `ci`, `testing`, `observability`, `databases`, `editors`,
  `cloud`, `security`, `ai-devtools`, `collaboration`, `finops`, `misc`.
- **Placements**: any subset of `post-task`, `welcome`, `splash`, `status`,
  `idle`, `panel`. The post-task card is the flagship and priced accordingly.
- **Negative targeting**: exclude verticals so a campaign never renders beside
  a declared competitor.
- **Rotation**: within the eligible set, selection is weighted, then ties are
  broken by a stable, non-identifying cohort hash of the install id, which
  keeps rotation even across installs without building any cross-session
  profile.
- **Frequency**: the client's own caps bound per-install exposure regardless of
  buy: at most 4 ads per process and at most one ad surface per 90 s, shared
  across all placements. Buying more weight buys the rotation, not the cap.

Targeting inputs the network will never accept, because the client never sends
them: repository contents, file paths, prompts, hostnames, provider/model
choices, or usage telemetry. Targeting is vertical + placement + weight only.

## Budget exhaustion and pause semantics

| Event                          | What the advertiser sees                          | What the client sees                       |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------ |
| Daily budget exhausted         | `budget.exhausted` webhook; creative marked spent for the day | Nothing — the slot silently falls through to house ads |
| Campaign paused                | Status flips to `paused`; spend stops             | Creative absent from the next feed revision |
| Credit exhausted               | `advertise.credit.exhausted`; campaigns auto-pause | Nothing — house ads fill the slot          |
| Feed unreachable               | (No dashboard surface)                            | House ads; the UI is never worse than no ad |

## API sketch

```
GET  https://ads.usingopen.com/v1/feed            # existing; install id only
POST https://ads.usingopen.com/v1/impression      # { adId } + install id
GET  https://ads.usingopen.com/v1/click?ad&to     # records, then 302s to `to`
POST https://ads.usingopen.com/v1/conversion      # { adId, kind } + install id
```

Dashboard API lives under `usingopen.com/advertise/api/` (campaign CRUD, pause
and resume, metrics rollups, credit balance) and is out of scope for the TUI
packages; this document pins the contract the ad server and the dashboard must
honor, not their implementation.

## Non-goals

- No third-party SDK, no Google, no retargeting pixel, no cross-site profile.
- No auto-open: the TUI renders the domain as text and the terminal opens a
  link only on an explicit click.
- No per-user pricing, no auctions that leak a bid into the client feed.
- No creative categories outside the reviewed devtool verticals.
