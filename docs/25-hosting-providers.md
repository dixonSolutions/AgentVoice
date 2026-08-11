# 25 — Hosting Providers: Pluggable Tunnels Beyond Tailscale

> Added: August 2026

Before this, the only supported way to reach the bridge from your phone was
Tailscale, configured by hand (`scripts/setup.sh`) with the tailnet hostname
pasted manually into `config.json`. `src/providers/hosting/` generalizes that
into a `HostingProvider` interface — Tailscale stays the default, but
Cloudflare Tunnel, ngrok, Azure Dev Tunnels, plain LAN, loopback-only, and
bring-your-own-reverse-proxy are equally supported, one-click setups from the
Config → Serve → **Network** tab.

See [`src/providers/hosting/types.ts`](../src/providers/hosting/types.ts) for
the full interface.

## Providers

| Provider | id | CLI required | Terminates TLS itself | Public exposure | Notes |
| --- | --- | :---: | :---: | :---: | --- |
| Tailscale (default) | `tailscale` | ✅ `tailscale` | ✅ (`tailscale serve`) | ✅ (your tailnet) | Also supports Headscale via `loginServer` |
| Cloudflare Tunnel | `cloudflare` | ✅ `cloudflared` | ✅ | ✅ (public internet) | Quick tunnel (rotating URL) or named tunnel (stable hostname, needs `cloudflared tunnel login` once) |
| ngrok | `ngrok` | ✅ `ngrok` | ✅ | ✅ (public internet) | Needs `NGROK_AUTHTOKEN` in `.env`; free tier rotates the URL unless you reserve a domain |
| Azure Dev Tunnels | `devtunnel` | ✅ `devtunnel` | ✅ | ✅ (public internet) | Persistent tunnel ID reused across restarts, unlike ngrok free tier |
| LAN | `lan` | — | — (see below) | Local network only | Advertises `http://<lan-ip>:<port>`; phone mic capture needs HTTPS — see below |
| Local | `local` | — | — | This machine only | Loopback-only, matches `npm run dev` — explicit "just testing" choice |
| Manual | `manual` | — | — | Depends on your proxy | Bring your own reverse proxy (nginx/Caddy); just stores the URL you give it. Safe fallback when nothing else is detected. |

## Zero-touch migration for existing Tailscale users

`settings.hosting.provider` is **optional** — leave it unset and the registry
auto-detects:

1. Explicit `settings.hosting.provider`, if set.
2. An existing `*.ts.net` `runModes.serve.publicBaseUrl` → `tailscale` (this is
   what every pre-existing install already has; no config edits needed).
3. Fallback: `manual`.

See [`src/providers/hosting/registry.ts`](../src/providers/hosting/registry.ts)
(`detectActiveHostingProviderId`). Running `Setup` for any provider from the
Config UI persists the explicit `provider` id on success, so the choice sticks
even if the resulting public URL doesn't match the `*.ts.net` heuristic (e.g.
ngrok, Cloudflare, Dev Tunnels).

On every boot in `serve` mode, `src/index.ts` calls the active provider's
`sync()` — for Tailscale this re-points `tailscale serve` at the current
backend port, replacing the old standalone `scripts/sync-tailscale-serve.sh`
step (still invoked by `scripts/restart.sh`; running both is harmless and
idempotent).

## Config UI (Config → Serve → Network)

- **Provider picker** — Tailscale pre-selected when detected (Hick's Law: the
  common case needs zero decisions); each option shows live install/active
  status so advanced providers stay out of the way until you pick one.
- **Device name field** — only shown for providers that use it (`tailscale`
  hostname, `cloudflare` stable hostname, `manual` public URL — required for
  manual since there's nothing to auto-detect).
- **Run setup** — streams human-readable progress; **Check health** — runs the
  provider's doctor checks (CLI installed, signed in, tunnel pointed at the
  right port, …).
- **Reset to auto-detect** — clears the explicit override and falls back to
  the detection order above.

## Setup API (`src/routes/hostingAdmin.ts`)

Setup can block on interactive CLI auth (`tailscale up`, `cloudflared tunnel
login`, …), so it runs in the background; the client streams progress over the
control socket and can also poll as a WS-disconnect-safe fallback.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/admin/hosting-providers` | GET | Every provider's capabilities + `detect()` result, plus which one is currently active |
| `/api/admin/hosting-providers/active` | PATCH | Set (`{ provider }`) or clear (`{ provider: null }`) the explicit override |
| `/api/admin/hosting-providers/setup` | POST | `{ provider, hostname?, loginServer? }` → `{ runId }` immediately; progress pushed as `{ type: 'hosting_setup_progress', runId, provider, message, done, result? }` over `/ws/control` |
| `/api/admin/hosting-providers/setup/:runId` | GET | Poll a run: `{ events, done, result }` |
| `/api/admin/hosting-providers/doctor?provider=` | GET | Doctor checks for one provider, or all if omitted |

This is a distinct namespace from the pre-existing `/api/admin/hosting` (ports
+ `runMode` only, see `docs/21-serve-self-hosting.md`) — that endpoint is
unchanged.

## LAN provider and HTTPS

Phone mic capture (`getUserMedia`) requires a secure context, which plain HTTP
over a LAN IP is not. Turning on `settings.hosting.lan.useTls` and running
setup generates a [mkcert](https://github.com/FiloSottile/mkcert) certificate
for the LAN IP — but the bridge itself only speaks HTTP; adding native HTTPS
support to the Fastify server was attempted and reverted (it forces a
different `FastifyInstance` generic type, which cascades through the entire
codebase). **Front the bridge with a lightweight reverse proxy** (Caddy/nginx)
using the generated cert if you need LAN HTTPS today.

## Adding a new provider

1. Create `src/providers/hosting/<id>.ts` implementing `HostingProvider`
   (`detect`, `getPublicUrl`, `setup`, `sync`, `doctor`).
2. Use `createBinResolver()` (`src/providers/binResolve.ts`) for CLI path
   resolution, and the shared write helpers in
   [`src/providers/hosting/persist.ts`](../src/providers/hosting/persist.ts)
   (`persistPublicBaseUrl`, `persistHostingSection`) instead of writing
   `config.json` directly.
3. Add the id to `HOSTING_PROVIDERS` in `src/config.ts` and register the
   provider in `src/providers/hosting/registry.ts`.
4. Nothing else changes — the setup API, doctor API, and Config UI all
   iterate the registry generically.

## Testing notes

Tailscale CLI calls are not exercised by the agent in this repo's test
environment (Tailscale is blocked without `proxychains4`/similar here);
`registry.ts`'s pure config-based detection is unit-testable without shelling
out. Manual verification was done directly against an installed `tailscale`
CLI on the target laptop (`detect()` and `doctor()` — read-only — were
exercised; `setup()` was intentionally **not** run against the real tailnet
from an agent session to avoid repointing the production `tailscale serve`
target away from its actual port).
