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
| LAN | `lan` | — | ✅ with `useTls` | Local network only | Generates a mkcert cert and serves it directly — see below |
| Local | `local` | — | ✅ with a cert | This machine only | Loopback-only, matches `npm run dev` — explicit "just testing" choice |
| Manual | `manual` | — | ✅ with a cert | Depends on your proxy | Bring your own reverse proxy (nginx/Caddy), or set `HTTPS_CERT_PATH`/`HTTPS_KEY_PATH` and let the bridge terminate TLS. Safe fallback when nothing else is detected. |

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

## Native HTTPS (bring your own cert)

Phone mic capture (`getUserMedia`) requires a secure context, which plain HTTP
over a LAN IP or a bare public IP is not. Every tunnel provider above supplies
that for free by terminating TLS at its edge. Without a tunnel, set both:

```bash
HTTPS_CERT_PATH=/path/to/cert.pem
HTTPS_KEY_PATH=/path/to/key.pem
```

and the bridge terminates TLS itself — no reverse proxy needed. Setting only
one is a startup error rather than a silent fallback to HTTP, since serving
plaintext to an operator who believes otherwise is the worse failure.

This is honoured in **serve mode only**; test mode is the local dev profile,
where the Angular dev server proxies to a plain-HTTP backend.

`src/tls.ts` loads the material and `RunModeInfo.tls` carries it. Anything
building a URL to the bridge must branch on it rather than assume `http://` —
`runMode.backendUrl` already does.

> **Implementation note.** Fastify's `https` option is deliberately not used:
> it selects the `FastifyHttpsOptions` overload, which retypes the instance as
> `FastifyInstance<https.Server>` and stops matching the bare `FastifyInstance`
> that every `src/routes` module accepts — the cascade that sank an earlier
> attempt. `src/server.ts` passes `serverFactory` instead, which stays on the
> default-generic overload, so the ~36 annotations across the codebase are
> untouched. One consequence: `app.listen()`'s returned address derives its
> scheme from the unset `https` option, so `startServer` corrects it before
> logging.

### With the LAN provider

`settings.hosting.lan.useTls` + setup generates a
[mkcert](https://github.com/FiloSottile/mkcert) certificate for the LAN IP,
writes the two paths into `.env`, and advertises an `https://` URL. **Restart
the bridge** to pick it up — `doctor()` reports "Bridge is serving HTTPS" as
failing until you do, which distinguishes "cert configured" from "cert in use."

The phone must also trust the mkcert root CA (`mkcert -CAROOT`), or the browser
rejects the certificate before it ever prompts for the mic.

### With a tunnel provider

Redundant — the tunnel already terminates TLS, so a cert on the bridge just
encrypts the loopback hop twice. It is handled rather than forbidden:
`tailscale serve` is pointed at `https+insecure://`, and `cloudflared` gets
`--no-tls-verify`. ngrok and Dev Tunnels still assume a plain-HTTP upstream and
their `doctor()` flags the combination — unset the two variables for those.

### Public IP without a tunnel

Native TLS covers the listener, but not certificate *lifecycle*: there is no
ACME client in the bridge, so a Let's Encrypt cert is yours to renew. Caddy
does issuance and renewal in a few lines and adds rate limiting and security
headers the bridge does not have. For internet-facing hosting, prefer it (or a
tunnel); native TLS is aimed at LAN and at certs you already manage.

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
