"""Host a server on a given map through the node's /host endpoint and capture views there.
python tools/e2e/shots_map.py <mode> <map-id> [name]
"""
import json, sys, time, os, urllib.request
from playwright.sync_api import sync_playwright

mode = sys.argv[1] if len(sys.argv) > 1 else 'arena'
map_id = sys.argv[2] if len(sys.argv) > 2 else 'lavaarena'
name = sys.argv[3] if len(sys.argv) > 3 else f'Shot {map_id}'
base = os.environ.get('AR_URL', 'http://localhost:7770')
out = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)

body = {'name': name, 'mode': mode, 'maxPlayers': 8, 'maps': [map_id], 'mapSource': 'original', 'options': {'botsPerTeam': 0}}
req = urllib.request.Request(base + '/host', data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
print('host:', urllib.request.urlopen(req, timeout=20).read()[:200])

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.on('console', lambda m: print('console:', m.text[:300]) if m.type == 'error' else None)
    page.goto(base + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'MapShot')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate(click, 'PLAY NOW'); time.sleep(1)
    page.locator('tr.row').first.wait_for(timeout=15000)
    time.sleep(2)
    page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", name)
    time.sleep(0.5)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ig-screen').wait_for(timeout=120000)
    time.sleep(1)
    page.evaluate(click, 'AUTO-ASSIGN')
    time.sleep(10)
    page.evaluate("() => document.querySelectorAll('.pause-menu, .ig-screen').forEach(e => e.remove())")
    for i, (yaw, pitch) in enumerate([(0, -0.35), (1.57, -0.35), (3.14, -0.35), (4.71, -0.35)]):
        page.evaluate("([y, p]) => { const c = window.__ar.client(); c.input.yaw = y; c.input.pitch = p; }", [yaw, pitch])
        time.sleep(2.5)
        page.screenshot(path=os.path.join(out, f'50_map_{map_id}_{i}.png'))
    browser.close()
