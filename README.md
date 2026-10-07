# Ascend Reborn
<img width="1600" height="900" alt="image" src="https://github.com/user-attachments/assets/4d0f5725-74d0-42ad-9285-c5378a1aecad" />
<img width="1200" height="698" alt="demo" src="https://github.com/user-attachments/assets/a78aec11-186e-4d6b-a106-99660687676c" />

An unofficial, fan-made revival of **Tribes: Ascend** gameplay that runs in the browser (Chrome/Edge) with
self-hosted Node servers — skiing, jetting, spinfusors, CTF and the other TA game modes, with bots.

> Not affiliated with or endorsed by Hi-Rez Studios. *Tribes* and *Tribes: Ascend* are trademarks of their owners.
> This repository contains **no** game assets. The original maps, models, textures, sounds and UI art are read from
> **your own copy** of Tribes: Ascend by the local importer, stay on your machine (`maps-original/` is git-ignored),
> and must not be redistributed. Without an import the game still runs on generated maps with procedural art.
<img width="2091" height="818" alt="image" src="https://github.com/user-attachments/assets/54b62d5a-5dde-41cb-ace4-17b05f292482" />
<img width="2167" height="1256" alt="image" src="https://github.com/user-attachments/assets/c8f567ba-462c-4e57-8dc8-ce620b142409" />
<img width="2164" height="1254" alt="image" src="https://github.com/user-attachments/assets/2dfe714a-1739-497d-b7e8-6e4dcf025f74" />
<img width="2165" height="1259" alt="image" src="https://github.com/user-attachments/assets/a6b669b2-9eb9-4a2b-85ea-48c4a2557c7f" />

---
## Launcher (Windows)

`AscendRebornLauncher.exe` (attached to every GitHub Release) walks through the whole Quick Start for you —
no command prompt needed. Save it anywhere and run it.

| Button | What it does |
| --- | --- |
| **Install** (green, one click) | Does the whole Quick Start: installs Node.js and Git if missing, clones the repository, runs `npm install`, then imports your Tribes: Ascend assets. Refreshes `PATH` after each install, so a fresh machine needs no restart. |
| **Choose game folder** | Where the clone should live (defaults to the folder next to the exe). |
| **Download the game** | `git clone` of this repository. |
| **Install dependencies** | `npm install`. |
| **Re-import Tribes: Ascend assets** | Finds your existing T:A install and runs `npm run ta-import -- --all` (re-runnable after an update). |
| **Install Node.js / Install Git** | "One step at a time" helpers: opens the Node v24 MSI, and installs Git with `winget install Git.Git`. |
| **Start game (server)** / **Start game (client)** | Launches `npm start` / `npm run play` in its own console window, then opens <http://localhost:7770>. |
| **Open browser** / **Stop servers** | Opens the game page, and closes the game console windows the launcher started. |
| **Check for updates** | Reads the latest GitHub Release, compares it with the local `package.json`, and reports how many commits behind `origin/main` you are. A repository with no published release yet is reported as such, not as offline. |
| **Update the game** | `git pull` + `npm install` + a re-import of the Tribes: Ascend assets, in that order. |
| **Update this launcher** | Downloads the newest launcher exe from the Release and swaps itself out on the next start. |

It shows the game's own splash art as its banner when your import is present, and falls back to a drawn
banner otherwise (no Hi-Rez art ships in this repository).

Building it from source (Windows, no extra SDK — it uses the .NET Framework 4.x compiler in the box):

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launcher\build.ps1
```

Output lands in `tools\launcher\bin\` (git-ignored); attach the exe to a Release as an asset.

---
## Quick Start Guide

**Windows**
```
You'll need nodejs with npm:
install https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi and keep "npm package manager" selected.

You'll also need git from https://git-scm.com/download/win or from command prompt (as admin) :
winget install --id Git.Git -e --source winget

Go to your desired target folder & open command prompt from there via right-click in explorer,
or go there via the command prompt (WIN+R and cmd [ENTER]) with "cd D:\games" or whatever your folder is.

Once your target folder is open in command prompt, type these commands:
  git clone https://github.com/Cognito-Inc-451/Tribes_Ascend_Reborn
  cd Tribes_Ascend_Reborn
  npm install
  npm run install-ta

if you still/already have T:A installed, you can open command prompt in the games' folder to execute the commands listed above
but replace "npm run install-ta" with "npm run ta-import -- --all"

then either type:
  npm run play
to play without running servers (you can still join others or host a server from ingame)

or:
  npm start
to host servers and play simultaneously

And finally, type "localhost:7770" in Chrome's address bar
To close, close the tab and the command prompt window (or press CTRL+C in it).
To run the game again, "npm start" or "npm run play"

If later there is an update on github, you can just type "git pull" from with the Tribes_Ascend_Reborn folder to update
also run "npm run ta-import -- --all" again as it may also have been updated

An installer / updater should automate all this soon - see "Launcher (Windows)" below.
```

## Features

**Gameplay (tuned to TA's own defaults, read from `TribesGame.u`)**
- TA movement: skiing with the downhill slope boost, per-armour air control and ski acceleration caps, jetting, fall
  ("splat") damage. Gravity, jump speed, per-class masses and every projectile's speed, gravity scale, inheritance and
  momentum come from TA's default properties. As in TA, energy does not recharge while the jet key is held, and jet
  lift fades as you climb toward the jetpack's max thrust speed (72 km/h).
- Knockback follows TA's script (disassembled from `TribesGame.u`): your own explosions push you 1.5x, impulse stays
  full near the centre of the blast, grounded targets are always lifted, and some weapons add an extra upward kick, so
  disc jumps, nade jumps and mid-airs feel like the original. Your own discs and grenades are predicted, so the jump
  is instant.
- All 9 classes (Pathfinder, Sentinel, Infiltrator, Soldier, Technician, Raider, Juggernaut, Doombringer, Brute) with
  their weapons, belts, packs, perks and upgrades. Everything is unlocked.
- Fractal grenades behave like TA's: the orb rises, then fires damaging shards at the ground around it for 3 s
  before its final blast.
- Capture and Hold uses TA's goal score (100 per control point, 30 min limit). Turrets, stations and radars near a
  point belong to whoever holds it (neutral ones stay quiet until the point is taken). A Technician's turrets
  disappear when he dies or changes class.
- Game modes: **CTF**, **CTF Blitz**, **Team Deathmatch**, **Rabbit**, **Arena**, **Capture and Hold**, plus Ski Training.
- Bases: generators, inventory stations (walk in to restock, like TA), repair stations, turrets, radar, vehicle pads,
  vehicles (Grav Cycle, Beowulf, Shrike), deployables and call-ins (tactical strike, supply drop, orbital strike).
- Bots (Recruit to Godlike, Adept by default) with roles (cappers, chasers, defenders, offense, farmers, roamers).
  They route into base interiors (generator rooms, CaH points) around enemy force fields, shell the enemy generator,
  restock at an inventory station they can actually reach, climb base shafts on a full energy tank, walk known
  routes back out of a base after spawning or restocking inside (clearing the doorway before roaming), skip stations
  whose generator is down, and roamers keep human players company (escorting
  or hunting them). Servers keep their bot count and only drop bots when the server is nearly full, to make room for
  players.
- Host options: bots per team (10 by default), bot skill, time/score limits, infinite ammo, infinite energy, no fall
  damage, **infinite call-ins**, **vehicles** on/off, a **credit multiplier** and **gravity** (50%–200% of TA's, for
  players, projectiles, flags and vehicles).

**With your Tribes: Ascend data imported (`npm run install-ta` or `npm run ta-import -- --all`)**
- The original maps (geometry, terrain with its layer normal maps, textured BSP brushes, textures with normal and
  specular maps plus each material's diffuse tiling and colour tint, TA's translucent/additive materials such as light
  beams and glass, prefab interiors, lava/water, kill
  and pain volumes such as Lava Arena's lava and Blueshift's space), player/weapon/vehicle/station models, TA's class
  skins (team armour and the Mercenary sets), sounds (every weapon and belt item's own fire and explosion sounds,
  looping automatic fire, reloads and draws,
  vehicles' engines and weapons, stations, generators, turrets, deployables, call-ins, deaths, impacts, CTF
  stingers), TA's particle effects for projectile trails, explosions and fractal shards (exported from the weapon
  particle systems), voice packs (VGS), music, HUD icons, menu art and the startup splash.
- Map mechanics from the levels themselves: base force fields that keep enemies out while their generator is up
  (TA's team blockers on Bella Omega, Permafrost and Sunstar's flag shields, plus the base door fields of Katabatic,
  Stonehenge, Blueshift, ...), your own base can't be damaged by your team, accelerators and launch pads (Blueshift,
  Bella Omega, Katabatic, Stonehenge, ...), and spawn points picked like TA does (a random team start, skipping the
  last one used and any with an enemy in sight; maps without team starts are split in two halves so each team
  spawns on its own side).
- Base generators, base turrets and radars are solid (players and vehicles collide with them); inventory, repair
  and vehicle pads stay walk-in. Base assets show damage (darkening, smoke and sparks) and look dead when
  disabled (unpowered: dimmed; destroyed: charred, slumped turret heads, no glow).
- TA's baked (Lightmass) lighting on map meshes, packed into a few atlas pages per map (Settings → Video → Baked
  Lighting). The lightmap texels are linear, so their colour matches each level's sun and sky.
- TA's own animations: third-person locomotion blended like TA's AnimTree (8-way run and ski, flight, landing,
  per-weapon sets, aim offsets, fire/reload/weapon-switch on the upper body) and the first-person arms + weapon
  meshes playing their 1P animations (idle, fire, reload, retrieve), with an ammo readout on the weapon.

**Client**
- TA-style front end: login, server browser, host game, class/loadout editor with a live model preview,
  team and class screens, scoreboard, career stats, TA HUD, VGS menu, minimap, kill feed, chat.
- HUD left column, top to bottom: net stats (F10), the VGS menu and the last VGS lines, then chat (the last 10
  messages stay for 30 s; all of them while typing). The crosshair is red and slightly larger by default.
- Loading screen laid out like TA's (next map, game type, rules of engagement over a map screenshot, gameplay tip);
  the screenshot is captured on your first visit to a map.
- Spectating: a smoothed chase camera on players and bots; if you chose to spectate you stay a spectator when the map
  changes.
- Class screen (key I, also in the main menu): classes, loadout slots (weapons, belt, pack, perks, skin, voice), the
  stats of the hovered item and a live 3D preview with your skin and the weapon you are choosing; skin and voice
  changes made in game apply at once. New players get an original TA voice when voice packs are imported.
- Graphics (Settings → Video, with Low/Medium/High/Ultra presets that only touch performance options):
  HDR 16-bit pipeline with ACES/AgX/Neutral/Cineon tone mapping, bloom, screen-space god rays, SSAO, UE3-style
  exponential height fog with sun inscattering (from each map's fog actor), depth of field, camera motion blur,
  screen-space reflections on water, soft shadows (1K–4K), contrast/saturation/vibrance/temperature/tint, colour
  grade looks, vignette, film grain, chromatic aberration, sharpen, anisotropic filtering, texture quality up to the
  original resolution (Ultra), water quality, translucent energy force fields, bullet tracers, weather.

**Networking (no central server)**
- Every running copy is a *node*. Nodes find each other on the LAN (UDP multicast) and on the internet through the
  public BitTorrent DHT (bootstrapped from the router hosts with literal-IP fallbacks and retried while the routing
  table is empty), then exchange server lists over HTTP. WebTransport (UDP) with WebSocket fallback.
- NAT traversal, in order: **UPnP / NAT-PMP** port mapping → **relay** through another player's reachable node
  (TURN-like tunnel over WebSocket, automatic when your router refuses port mapping). Players connect to relayed
  games exactly like direct ones.
- Friends, global chat and direct messages between nodes (signed with per-install keys).

---

## Requirements

- **Node.js 22+** (24 recommended) and npm.
  install https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi and keep "npm package manager" selected
  - optional: to verify nodejs: open command prompt (WIN+R and type cmd + press [Enter]) and type "node -v" 
  - optional: to verify npm: type "npm -v" in command prompt
- **Chrome or Edge** (WebTransport, WebGL2). Firefox works over WebSocket. Chrome is recommended.
- (automatically downloaded during setup) the original content: about **11 GB** for the Tribes: Ascend files, plus room for the archive while
  `install-ta` runs (~20 GB free recommended). The imported data itself (`maps-original/`) is a few hundred MB.

## Setup (see Quick Start Guide above)

```bash
git clone https://github.com/Cognito-Inc-451/Tribes_Ascend_Reborn
cd Tribes_Ascend_Reborn
npm install

# Optional but recommended: download Tribes: Ascend ("Parting Gifts" community archive) next to this folder,
# unpack it (no extra sub-folder) and run the importer. Skips the download when the game is already there.
npm run install-ta

npm start            # builds the client, starts the node + the default servers
# open http://localhost:7770
# or
npm run play        # build and run the node without running servers (joining/hosting works)
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

Press **V**, then the letters shown on screen (they follow your keyboard layout: on AZERTY the Z key is Z)

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
<img width="404" height="667" alt="image" src="https://github.com/user-attachments/assets/11d197c9-972b-4aad-a552-9986799b4c54" />

Running a server for other players (VPS sizing, ports, systemd units, master key,
`deploy/servers-vps.json`): see [HOSTING.md](./HOSTING.md).

- *Play → Host Game*: pick game type, **map set** (original maps by default; generated "Reborn" layouts on request),
  map or rotation, bots per team and skill, limits and rule toggles, then *Launch*. Your game is announced to this PC,
  your LAN and (with port mapping or a relay) the internet, and shuts down after 10 minutes without players.
- Dedicated servers: edit `config/servers.json` (mode, maps, bots `fillTo` = number of bots / `difficulty`, max
  players, options). Bots leave only when the server is down to 2 free slots. The default config runs one server per
  mode on the original maps.
<img width="2167" height="1254" alt="image" src="https://github.com/user-attachments/assets/1c270158-26c3-4e2f-b2aa-a19cec829cdb" />
<img width="2167" height="1256" alt="image" src="https://github.com/user-attachments/assets/8f6447c4-cf99-4c1d-8052-adeaa74bb6e6" />


## Repository layout

```
packages/shared   simulation (movement, projectiles, collision), game data (classes, items, modes, VGS), protocol
packages/server   game servers (authoritative 60 Hz match + bots), local node (discovery, relay, social, assets)
packages/client   Three.js renderer, UI, prediction/interpolation, audio
packages/master   optional legacy master server (not needed)
tools/ta-import   reads TA's UE3 packages (maps, meshes, skeletal meshes, textures, sounds, particle effects, UI)
tools/e2e         Playwright smoke test
scripts           install-ta (download + unpack + import)
config            server configuration
```

## Known gaps

- Lightmaps are imported for static meshes only; terrain and BSP surfaces still use dynamic lighting, and lightmaps
  are stored at reduced resolution to keep map downloads small. Materials use one diffuse, normal and specular map
  each, with the material's diffuse tiling and tint (TA's detail/overlay layers, panners and emissive layers such as
  glowing lava cracks are not reproduced).
- TA particle effects are drawn as camera-facing sprites: mesh emitters, beams' noise and per-particle material
  effects (distortion, depth fades) are approximated.
- Map force fields stop players but not shots, and Sunstar's flag shields let their own team through (TA blocks
  everyone) so flags stay capturable.
- There is no swimming. On water maps (Sulfur Cove, Hinterlands, ...) the sea or any fall below the kill height puts you
  back on the ground you were on a moment ago ("out of bounds", costs 10% health) instead of killing you; lava and
  space maps stay lethal.
- HDR is internal (16-bit rendering, tone-mapped to the display); browsers do not expose HDR output for WebGL.
- No UDP hole punching (WebRTC/STUN); hosts that cannot map ports rely on a reachable node to relay.
- Some unofficial/unfinished maps in TA's files (listed as `x_*`) are missing their streamed geometry.
