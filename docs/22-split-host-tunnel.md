# Split-host: container bridge + Tailscale front door

**AgentVoice runs in the incus container** (`dev` on the debian host) — bridge,
nginx, and AWS calls all live there. Your laptop or home PC is **not** the host;
it only runs the SSH tunnel and Tailscale Serve when you want a stable public URL
on that machine's MagicDNS name.

## Topology

```
Phone / browser
  → https://eva.tail14805e.ts.net     (Tailscale Serve — tunnel machine only)
  → http://127.0.0.1:15671            (SSH tunnel on tunnel machine)
  → ssh -L … borys@debian:5671
  → incus proxy host:5671 → container:5671
  → nginx :5671 in container           (PWA + /api /ws /mcp proxy)
  → agentvoice :1234 in container    (bridge API, Amazon Transcribe/Polly)
```

The bridge `publicBaseUrl` is the Tailscale HTTPS URL. All services (bridge,
nginx, `cursor-agent`, MCP, SQLite) run **inside the container**.

---

## Container setup (where AgentVoice is hosted)

Run these **inside the incus container**, e.g. `incus exec dev -- bash`:

1. **Clone / pull** the repo (e.g. `/root/Projects/AgentVoice`).

2. **Fix DNS** — required for Amazon Transcribe/Polly/Bedrock in LXC/incus:

   ```bash
   sudo bash scripts/install-fix-dns.sh
   ```

   Installs `fix-dns.service` + a 5-minute timer so `127.0.0.53` stub resolver
   does not break AWS again.

3. **Configure** `.env` (AWS keys, `APP_TOKEN`) and `config.json` on the container.

4. **Build and enable services:**

   ```bash
   npm run build
   systemctl enable --now agentvoice nginx
   ```

   See [`scripts/nginx-agentvoice.conf.example`](../scripts/nginx-agentvoice.conf.example)
   and incus proxy `host:5671 → container:5671`. Nginx must set
   `client_max_body_size 12m` (default `1m` returns **413** on longer Amazon
   Transcribe uploads).

5. **Verify from inside the container:**

   ```bash
   curl -s http://127.0.0.1:1234/healthz
   curl -s http://127.0.0.1:5671/healthz
   getent hosts transcribestreaming.us-east-1.amazonaws.com
   ```

### Transcribe failures in the container

If STT logs show `HTTP/2 stream is abnormally aborted`, DNS is almost always the
cause — not the phone or the tunnel machine:

```bash
sudo bash scripts/install-fix-dns.sh   # inside container
systemctl restart agentvoice
```

---

## Tunnel machine setup (optional — Tailscale public URL)

Only needed when Tailscale Serve runs on a **different** machine than the
container (e.g. eva → debian incus). **Do not** install `fix-dns` or
`agentvoice` here — only the SSH tunnel.

1. **SSH key auth** to the debian host (`ssh borys@100.118.238.2`).

2. **Install the tunnel service** on the tunnel machine:

   ```bash
   cd /path/to/AgentVoice
   bash scripts/install-remote-tunnel.sh \
     --remote borys@100.118.238.2 \
     --remote-port 5671 \
     --local-port 15671
   ```

   Writes `~/.config/agentvoice/tunnel.env` and enables
   `agentvoice-tunnel.service` (systemd user, `Restart=always`).

3. **Point Tailscale Serve** at the local tunnel port:

   ```bash
   tailscale serve --bg http://127.0.0.1:15671
   ```

4. **Verify from the tunnel machine:**

   ```bash
   bash scripts/doctor.sh
   curl -s https://eva.tail14805e.ts.net/healthz
   ```

## Operations

| Where | Task | Command |
|-------|------|---------|
| Container | Bridge status | `systemctl status agentvoice nginx fix-dns` |
| Container | Bridge logs | `journalctl -u agentvoice -f` |
| Container | Redeploy | `git pull && npm run build && systemctl restart agentvoice nginx` |
| Tunnel machine | Tunnel status | `systemctl --user status agentvoice-tunnel` |
| Tunnel machine | Tunnel logs | `journalctl --user -u agentvoice-tunnel -f` |
| Tunnel machine | Restart tunnel | `systemctl --user restart agentvoice-tunnel` |

Tunnel config: `~/.config/agentvoice/tunnel.env` on the **tunnel machine** (see
[`scripts/remote-tunnel.env.example`](../scripts/remote-tunnel.env.example)).

## Why the tunnel dies

Manual `ssh -f -N -L …` exits when the session drops or the machine reboots.
The systemd user unit keeps it alive with `Restart=always` and SSH
`ServerAliveInterval`.

## Related

- [`07-data-and-deployment.md`](./07-data-and-deployment.md) — run modes and ports
- [`21-serve-self-hosting.md`](./21-serve-self-hosting.md) — manual rebase / restart / live journal on the host
