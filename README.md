# Ascend Reborn

An unofficial, fan-made revival of **Tribes: Ascend** gameplay that runs in the browser (Chrome/Edge) with
self-hosted Node servers — skiing, jetting, spinfusors, CTF and the other TA game modes, with bots.

> Not affiliated with or endorsed by Hi-Rez Studios. *Tribes* and *Tribes: Ascend* are trademarks of their owners.
> This repository contains **no** game assets. The original maps, models, textures, sounds and UI art are read from
> **your own copy** of Tribes: Ascend by the local importer, stay on your machine (`maps-original/` is git-ignored),
> and must not be redistributed. Without an import the game still runs on generated maps with procedural art.

---

## Features

**Gameplay (tuned to TA's own defaults, read from `TribesGame.u`)**
- TA movement: skiing with the downhill slope boost, per-armour air control and ski acceleration caps, jetting, fall
  ("splat") damage. Gravity, jump speed, masses and every projectile's speed, gravity scale, inheritance and
  momentum come from TA's default properties, so disc jumps, nade jumps and mid-airs behave like the original.
- All 9 classes (Pathfinder, Sentinel, Infiltrator, Soldier, Technician, Raider, Juggernaut, Doombringer, Brute) with
  their weapons, belts, packs, perks and upgrades. Everything is unlocked.
- Game modes: **CTF**, **CTF Blitz**, **Team Deathmatch**, **Rabbit**, **Arena**, **Capture and Hold**, plus Ski Training.
- Bases: generators, inventory stations (walk in to restock, like TA), repair stations, turrets, radar, vehicle pads,
  vehicles (Grav Cycle, Beowulf, Shrike), deployables and call-ins (tactical strike, supply drop, orbital strike).
- Bots (Recruit to Godlike, Adept by default) with roles (cappers, chasers, defenders, offense, farmers). They route
  into base interiors (generator rooms, CaH points) and leave one by one as humans join.
- Host options: bots per team, bot skill, time/score limits, infinite ammo, infinite energy, no fall damage,
  **infinite call-ins** and a **credit multiplier**.

**With your Tribes: Ascend data imported (`npm run install-ta` or `npm run ta-import -- --all`)**
- The original maps (geometry, terrain, textures, prefab interiors, force fields), player/weapon/vehicle/station models,
  TA's class skins (team armour and the Mercenary sets), weapon and effect sounds, voice packs (VGS), music,
  HUD icons, menu art and the startup splash.

**Client**
- TA-style front end: login, server browser, host game, class/loadout editor with a live model preview,
  team and class screens, scoreboard, career stats, TA HUD, VGS menu, minimap, kill feed, chat.
- Loading screen laid out like TA's (next map, game type, rules of engagement over a map screenshot, gameplay tip);
  the screenshot is captured on your first visit to a map.
- Graphics: imported textures, image-based ambient light, soft shadows, bloom, colour grade, translucent energy force
  fields, travelling bullet tracers (Settings → Video → Bullet Tracers), weather, quality presets.

**Networking (no central server)**
- Every running copy is a *node*. Nodes find each other on the LAN (UDP multicast) and on the internet through the
  public BitTorrent DHT, then exchange server lists over HTTP. WebTransport (UDP) with WebSocket fallback.
- NAT traversal, in order: **UPnP / NAT-PMP** port mapping → **relay** through another player's reachable node
  (TURN-like tunnel over WebSocket, automatic when your router refuses port mapping). Players connect to relayed
  games exactly like direct ones.
- Friends, global chat and direct messages between nodes (signed with per-install keys).

---

## Requirements

- **Node.js 22+** (24 recommended) and npm.
- **Chrome or Edge** (WebTransport, WebGL2). Firefox works over WebSocket.
- For the original content: about **11 GB** for the Tribes: Ascend files, plus room for the archive while
  `install-ta` runs (~20 GB free recommended). The imported data itself (`maps-original/`) is a few hundred MB.

## Setup

```bash
git clone <this repo> Ascend_Reborn
cd Ascend_Reborn
npm install

# Optional but recommended: download Tribes: Ascend ("Parting Gifts" community archive) next to this folder,
# unpack it (no extra sub-folder) and run the importer. Skips the download when the game is already there.
npm run install-ta

npm start            # builds the client, starts the node + the default servers
# open http://localhost:7770
```

Already have Tribes: Ascend installed? Put this repository **inside** the game folder (next to `Binaries/`,
`Engine/`, `TribesGame/`) and run `npm run ta-import -- --all`, or point the importer at it with
`npm run ta-import -- --all --install "D:/Games/Tribes Ascend"`.

`npm run install-ta` options: `--dir <folder>` (where to unpack, default: the folder containing the repo),
`--zip <file>` (use an archive you already downloaded), `--keep-zip`, `--force` (re-download/unpack), `--no-import`.
The archive is fetched from Backblaze, falling back to the Wayback Machine copy.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Build the client and run the node with the dedicated servers from `config/servers.json` |
| `npm run play` | **Client mode**: build and run the node without dedicated servers (browse/join, *HOST GAME* still works) |
| `npm run dev` | Dev mode: node + Vite dev server with hot reload (client on http://localhost:5173) |
| `npm run install-ta` | Download + unpack Tribes: Ascend and run the importer (see above) |
| `npm run ta-import -- --all` | Import maps and assets from a local install (`--only <map>`, `--assets-only`, `--no-textures`, `--texmax 1024`) |
| `npm test` / `npm run typecheck` | Unit tests / type checks |
| `npx tsx packages/server/scripts/botmatch.ts ctf katabatic original 14 300` | Headless bot match (balance/perf testing) |

### Node flags and environment

| Setting | Effect |
|---|---|
| `--client` or `AR_CLIENT=1` (or `"clientOnly": true` in `config/servers.json` → `node`) | Client mode, no dedicated servers |
| `--offline` | No internet discovery, port mapping or relay (LAN only) |
| `--no-node` | Game servers only, no local node / web client |
| `--only ctf-original,tdm` | Start only these servers from the config |
| `--config <file>` / `AR_CONFIG` | Use another server config |
| `AR_UPNP=0` / `AR_DHT=0` / `AR_LAN=0` | Disable port mapping / BitTorrent DHT discovery / LAN discovery |
| `AR_RELAY=0` | Neither use nor offer relays |
| `AR_NODE_PORT=7770` | Node HTTP port |
| `PUBLIC_HOST=example.org` | Address advertised for dedicated servers |
| `ADMIN_PASSWORD=...` | Enables in-game admin commands (Esc → Admin: `map <id>`, `kick <name>`, `bots <n>`, `end`) |
| `AR_MAPS_ORIGINAL=<dir>` | Where imported content lives (default `maps-original/`) |

Ports: node `7770/tcp` (+ `7771/udp` LAN discovery); dedicated servers `7777–7784` (TCP for WebSocket, UDP for
WebTransport); hosted games `7800–7831`. With UPnP these are opened automatically.

**Relaying**: when your router refuses port mapping, your node keeps an outbound connection to a node that offers
relaying (one whose ports are reachable) and your hosted games are listed through it. Nodes with working port
mapping offer relaying to others automatically (limits: 8 hosts, 24 connections each). Opt out with `AR_RELAY=0`.

## Controls (defaults, from TA's `DefaultInput.ini`; rebind in Settings → Keybindings)

| Key | Action | Key | Action |
|---|---|---|---|
| W A S D | Move | Space | **Ski** (hold) |
| Right mouse | **Jetpack** | Left Ctrl | Jump |
| Left mouse | Fire | Shift | Zoom |
| 1 / 2 / Q | Primary / secondary / last weapon | Mouse wheel | Switch weapon |
| F | Throw belt item | C | Activate pack |
| E | Melee | R | Reload |
| G | Use (stations, vehicles) | Z | Drop flag |
| I / Enter | Class select / quick classes | P | Team select |
| 5 / 6 / 7 | Call-ins: tactical strike / supply drop / orbital strike | U | Deployables |
| V | **VGS** voice menu | T / Y | Chat / team chat |
| Tab | Scoreboard | B | Overhead map |
| X | Third person | Alt | Spot target |
| K | Suicide | F5 / F6 | Vote no / yes |
| F10 | Net stats | Esc | Menu |

Chat commands: `/g message` (global chat), `/w name message` (whisper), `/r message` (reply).

### VGS (Voice Game System)

Press **V**, then the letters shown on screen. Some favourites:

| Keys | Line | Keys | Line |
|---|---|---|---|
| V G S | Shazbot! | V F H | I have the flag! |
| V G Y / V G N | Yes. / No. | V F E | I'll retrieve our flag! |
| V G H / V G B | Hi. / Bye. | V F R | Retrieve our flag! |
| V G W | Woohoo! | V F D | Defend our flag! |
| V G C G | Good game | V A F | Get the enemy flag! |
| V G C N | Nice move! | V D B | Defend our base! |
| V G T B | I am the greatest! | V V T / V V S | Thanks. / Sorry. |
| V V H | Help! | V V W / V V M | Wait. / Move! |

Branches: **A**ttack, **D**efend, **F**lag, **G**lobal (**C**ompliment, **R**espond, **T**aunt), **N**eed,
**S**elf, **T**arget, **W**arning, **V**ery quick. With voice packs imported you hear the original lines.

## Hosting

- *Play → Host Game*: pick game type, **map set** (original maps by default; generated "Reborn" layouts on request),
  map or rotation, bots per team and skill, limits and rule toggles, then *Launch*. Your game is announced to this PC,
  your LAN and (with port mapping or a relay) the internet, and shuts down after 10 minutes without players.
- Dedicated servers: edit `config/servers.json` (mode, maps, bots `fillTo`/`difficulty`, max players, options).
  The default config runs one server per mode on the original maps.

## Repository layout

```
packages/shared   simulation (movement, projectiles, collision), game data (classes, items, modes, VGS), protocol
packages/server   game servers (authoritative 60 Hz match + bots), local node (discovery, relay, social, assets)
packages/client   Three.js renderer, UI, prediction/interpolation, audio
packages/master   optional legacy master server (not needed)
tools/ta-import   reads TA's UE3 packages (maps, meshes, skeletal meshes, textures, sounds, UI)
tools/e2e         Playwright smoke test
scripts           install-ta (download + unpack + import)
config            server configuration
```

## Known gaps

- Characters use procedural animation (TA's compressed animation sequences are not decoded yet).
- No UDP hole punching (WebRTC/STUN); hosts that cannot map ports rely on a reachable node to relay.
- Some unofficial/unfinished maps in TA's files (listed as `x_*`) are missing their streamed geometry.
