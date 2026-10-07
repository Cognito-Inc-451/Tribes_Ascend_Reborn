# Hosting Ascend Reborn

Who should run a server, where, and how. The player-side setup lives in
[README.md](README.md); this document is about running a server other people join.

## The four things that shape every hosting decision

1. **Every player runs a node on their own machine.** The client asks *its own* node for the
   server list (`GET /peers`), and the node answers only loopback requests
   ([node.ts](packages/server/src/node/node.ts) — `isLoopback`, 403 otherwise). A player who
   opens `http://your-vps:7770` in a browser gets an empty server list. Players run
   `npm run play` locally and find your servers through the master list, DHT, or LAN.
2. **Imported assets are local and non-redistributable.** `maps-original/` is built from each
   player's own copy of Tribes: Ascend and is git-ignored. Serving `/assets/*` to the public
   would be distributing Hi-Rez copyrighted content. Public servers therefore run with
   `--no-node`; players load textures/voices/models from their own machine. **Maps are the
   exception**: the game server streams the map it is hosting (`GET /map/<file>.arm.gz`), so
   players do *not* need an import to join your server — they get the map from you.
3. **Game connections are not TLS.** WebSocket is plain `ws://` on the game port
   ([ws.ts](packages/server/src/transport/ws.ts)); WebTransport is HTTPS/QUIC with a
   self-signed 13-day certificate advertised by hash (`serverCertificateHashes`), which is
   exactly what a bare IP needs. A page loaded over `https://` cannot open `ws://`, so
   hosting the client on GitHub Pages / Netlify / Cloudflare Pages does not work today.
   Serve the client over plain `http://` from a node, or don't serve it at all.
4. **The master server is in-memory.** Servers expire from `/servers` after 35 s; game
   servers re-announce every 10 s. It must be a long-lived process — a serverless free tier
   that sleeps empties the public list.

Consequence: **PaaS/serverless (Vercel, Netlify, Cloudflare Workers, Render free tier) is not
viable.** You need a box with a public IPv4, openable ports, and a process that stays up.

## Where to host

| Option | Good for | Notes |
|---|---|---|
| **Your own PC** (`npm start`) | LAN, friends, testing | UPnP opens ports automatically; needs the router to cooperate. |
| **VPS — game servers + master** (this document) | A public community of strangers | `--no-node`, so no copyrighted assets are served. ~4 vCPU / 8 GB for the full default set. |
| **VPS — full node** (`npm start` with the node) | A community where you *also* serve the web client | Exposes `/assets/*` of **your** import. Only do this with content you may distribute. |
| **VPS — relay-only node** | Helping NATed players host games | Needs only `7770/tcp` open; 8 hosted games relayed, 24 connections each. |
| Home server behind CGNAT / free tiers | — | Not usable: no public IPv4, no inbound ports, no long-lived process. |

Sizing: the default [config/servers.json](config/servers.json) runs 7 servers with 76 bots at
60 Hz authoritative simulation. On a 2 vCPU / 4 GB box run 2–3 servers with `bots.fillTo`
halved. Measure before committing:

```bash
npx tsx packages/server/scripts/botmatch.ts ctf katabatic original 14 300
```

## Ports

| Port | Proto | Purpose |
|---|---|---|
| `7777–7784` (your server ports) | **TCP + UDP** | TCP = WebSocket `/ws`; UDP = WebTransport `/game` on the same number. Also serves `GET /info` and `GET /map/*.arm.gz` over TCP. |
| `8787` | TCP | Master server (`GET /servers`, `POST /announce`). |
| `7770` | TCP | Local node — only if you deliberately run the full node variant. |
| `7771` | UDP | LAN multicast discovery — irrelevant on a VPS (`AR_LAN=0`). |

## VPS setup (Ubuntu 24.04 LTS)

```bash
# 1. Unprivileged user + app location
sudo useradd -m -s /usr/sbin/nologin ascend
sudo mkdir -p /opt/ascend && sudo chown ascend:ascend /opt/ascend

# 2. Node.js 24 (Node 22+ required) + git
sudo apt update && sudo apt install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v24.x

# 3. Code + dependencies
sudo -u ascend git clone https://github.com/Cognito-Inc-451/Tribes_Ascend_Reborn /opt/ascend
cd /opt/ascend && sudo -u ascend npm ci

# 4. Original maps (optional, from YOUR OWN copy of Tribes: Ascend)
#    Copy an existing import in, or run the importer (needs ~11 GB of game files
#    and ~20 GB free while unpacking; the import itself is a few hundred MB).
sudo -u ascend npm run install-ta
#    Existing import elsewhere?  sudo cp -a /path/to/maps-original /opt/ascend/maps-original

# 5. Config + secrets
sudo mkdir -p /etc/ascend
sudo cp deploy/servers-vps.json /opt/ascend/config/servers.json
sudo cp deploy/servers.env.example /etc/ascend/servers.env
sudo sh -c 'umask 077; printf "MASTER_KEY=%s\n" "$(openssl rand -hex 24)" > /etc/ascend/master.env'
sudo $EDITOR /etc/ascend/servers.env      # PUBLIC_HOST, MASTER_URL, MASTER_KEY, ADMIN_PASSWORD
sudo chown root:ascend /etc/ascend/*.env && sudo chmod 640 /etc/ascend/*.env

# 6. Firewall: game ports on BOTH protocols, plus the master
sudo ufw allow 7777:7780/tcp
sudo ufw allow 7777:7780/udp
sudo ufw allow 8787/tcp
sudo ufw enable
# Cloud providers (Hetzner/AWS/GCP/OCI) have a *second* security group — open the same ports there.

# 7. systemd units
sudo cp deploy/systemd/ascend-master.service deploy/systemd/ascend-servers.service /etc/systemd/system/
# optional, only for the full-node variant: deploy/systemd/ascend-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now ascend-master ascend-servers
systemctl status ascend-master ascend-servers
journalctl -u ascend-servers -f
```

Check it from outside: `curl http://YOUR_IP:8787/servers` must list your servers, and
`curl http://YOUR_IP:7777/info` must return JSON.

### What the units do

| Unit | Command | Why |
|---|---|---|
| `ascend-master.service` | `npm run start -w @ar/master` | Public server list on `8787`. Long-lived, in-memory. |
| `ascend-servers.service` | `npm run start -w @ar/server -- --no-node` | Dedicated games only; no `/assets`, no lobby endpoints. |
| `ascend-node.service` | `npm start` | Full node (web client + relay, `7770/tcp`). Optional — read its header: it serves `/assets/*` from your import, and remote players still run their own node for the server list. |

`--no-node` also disables the in-game *HOST GAME* menu (ports 7800–7831) — that is
intentional on a public box; players host from their own machines.

### Env file knobs (see [deploy/servers.env.example](deploy/servers.env.example))

| Variable | Effect |
|---|---|
| `PUBLIC_HOST` | Address advertised in `ws://host:port/ws` and `https://host:port/game`. Bare IP is fine. |
| `MASTER_URL` | Where servers announce (`http://ip:8787`). Unset = no master. |
| `MASTER_KEY` | Sent as `x-master-key`; must match the master's, else 403. |
| `ADMIN_PASSWORD` | In-game admin: `map <id>`, `kick <name>`, `bots <n>`, `end`. |
| `AR_UPNP=0` `AR_LAN=0` `AR_DHT=0` `AR_RELAY=0` | A VPS has no router; turn all discovery off. |
| `AR_MAPS_ORIGINAL` | Alternate location for the import. |
| `CERT_FILE` / `KEY_FILE` | Real PKI for `PUBLIC_HOST` (then `certHash` is null). Optional. |

`systemd` `EnvironmentFile` is not a shell file: no quotes, no `$()`, no `export`.

## Players joining a public server

1. Install per [README.md](README.md) (Node 24, Chrome/Edge) and run `npm run play`.
2. Open `http://localhost:7770`. The server list fills from DHT and the master.
3. To see your master even before DHT warms up, open
   `http://localhost:7770/?master=http://YOUR_IP:8787`.
4. No import needed to play on your server (the map is streamed to them); an import adds
   original textures, voices and models on their side.

DHT bootstraps from public BitTorrent DHT routers over outbound UDP; if your VPS provider
blocks outbound UDP, discovery falls back to the master list only.

## Rotating the master key

```bash
sudo sh -c 'umask 077; printf "MASTER_KEY=%s\n" "$(openssl rand -hex 24)" > /etc/ascend/master.env'
sudo $EDITOR /etc/ascend/servers.env      # set the same value
sudo systemctl restart ascend-master ascend-servers
```

## Optional: a real TLS certificate

Not required — self-signed WebTransport certificates are accepted via `serverCertificateHashes`,
and WebSocket is plain `ws://`. If you own a domain and want real PKI:

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d play.example.org
sudo mkdir -p /etc/ascend/tls
sudo cp /etc/letsencrypt/live/play.example.org/fullchain.pem /etc/ascend/tls/
sudo cp /etc/letsencrypt/live/play.example.org/privkey.pem  /etc/ascend/tls/
```

Then set `CERT_FILE`/`KEY_FILE` in `/etc/ascend/servers.env` and `PUBLIC_HOST=play.example.org`.
Note a reverse proxy on 443 has **not** been validated against the `/ws` upgrade, `/info`,
`/map/*` and QUIC paths — fronting game ports with nginx/Caddy is untested; connect direct.

## Known limits to plan around

- No UDP hole punching (WebRTC/STUN). Players behind a router that refuses port mapping rely
  on a reachable node offering relaying (8 hosts, 24 streams each, 64 KB frames).
- The master has no persistence, clustering, or auth beyond a shared key; it is a list, not an
  account system. Rate limits: 120 reads and 60 announces per 10 s per address.
- `region` in a server config is advertised to the master but not shown in the client's server
  list today — put it in the server *name* if you want players to see it.
- WebTransport needs the native `@fails-components/webtransport` module. If it cannot load on
  your Linux box, the server logs `WebTransport unavailable ...; WebSocket only` and keeps
  working over `ws://` — check for that line in `journalctl -u ascend-servers`.

## Uninstall

```bash
sudo systemctl disable --now ascend-master ascend-servers
sudo rm /etc/systemd/system/ascend-{master,servers}.service && sudo systemctl daemon-reload
sudo rm -rf /etc/ascend /opt/ascend && sudo userdel ascend
```
