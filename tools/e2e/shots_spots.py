"""Free-camera captures of map spots (spectator, no deploy):
python tools/e2e/shots_spots.py <mode> <map-id> "x,y,z,yaw,pitch" ["x,y,z,yaw,pitch" ...]
"""
import json, sys, time, os, urllib.request
from playwright.sync_api import sync_playwright

mode, map_id = sys.argv[1], sys.argv[2]
spots = [[float(v) for v in s.split(',')] for s in sys.argv[3:]]
name = f'Spots {map_id}'
base = os.environ.get('AR_URL', 'http://localhost:7770')
out = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)
body = {'name': name, 'mode': mode, 'maxPlayers': 8, 'maps': [map_id], 'mapSource': 'original', 'options': {'botsPerTeam': 0}}
req = urllib.request.Request(base + '/host', data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
try:
    print('host:', urllib.request.urlopen(req, timeout=20).read()[:120])
except urllib.error.HTTPError as e:
    # Host limit reached: an earlier "Spots <map>" server is still up and gets reused below.
    print('host:', e.code, e.read()[:120])

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.goto(base + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    # Optional settings overrides, e.g. AR_SETTINGS='{"bakedLighting": false}'.
    if os.environ.get('AR_SETTINGS'):
        page.evaluate("(o) => Object.assign(window.__ar.settings, o)", json.loads(os.environ['AR_SETTINGS']))
    tag = os.environ.get('AR_TAG', '')
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'SpotShot')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate(click, 'PLAY NOW'); time.sleep(1)
    page.locator('tr.row').first.wait_for(timeout=15000)
    time.sleep(2)
    page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", name)
    time.sleep(0.5)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ig-screen').wait_for(timeout=120000)
    time.sleep(6)
    page.evaluate("() => document.querySelectorAll('.ig-screen, .pause-menu').forEach(e => e.style.display = 'none')")
    # Spectate so a spawn does not take over the camera.
    page.evaluate("() => window.__ar.client().session.send({ t: 'team', team: 255 })")
    time.sleep(2)
    # Optional JS run in the page before capturing (debug tweaks), e.g. AR_EVAL='window.__ar.lightmap.lmGain.value = 0.5'.
    if os.environ.get('AR_EVAL'):
        page.evaluate("(s) => (0, eval)(s)", os.environ['AR_EVAL'])
    for i, (x, y, z, yaw, pitch) in enumerate(spots):
        page.evaluate("([x, y, z, yaw, pitch]) => { const c = window.__ar.client(); c.spec.free = true; c.spec.pos.set(x, y, z); c.spec.yaw = yaw; c.spec.pitch = pitch; c.input.yaw = yaw; c.input.pitch = pitch; }", [x, y, z, yaw, pitch])
        time.sleep(4)
        page.screenshot(path=os.path.join(out, f'55_spot_{map_id}{tag}_{i}.png'))
    browser.close()
