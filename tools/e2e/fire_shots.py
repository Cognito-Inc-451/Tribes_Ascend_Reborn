"""Fires a weapon in game and captures frames: python tools/e2e/fire_shots.py <class> <primary> [secondary]
Used to look for rendering glitches (black squares, missing viewmodel) while shooting.
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

cls, primary = sys.argv[1], sys.argv[2]
secondary = sys.argv[3] if len(sys.argv) > 3 else None
base = os.environ.get('AR_URL', 'http://localhost:7770')
out = os.path.join(os.path.dirname(__file__), 'shots')
name = f'Fire {int(time.time()) % 100000}'
body = {'name': name, 'mode': 'ctf', 'maxPlayers': 8, 'maps': ['stonehenge'], 'mapSource': 'original', 'options': {'botsPerTeam': 3}}
req = urllib.request.Request(base + '/host', data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
try:
    print('host:', urllib.request.urlopen(req, timeout=20).read()[:60])
except urllib.error.HTTPError as e:
    print('host:', e.code, e.read()[:100])

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.on('console', lambda m: print('console:', m.text[:300]) if m.type == 'error' else None)
    page.goto(base + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'Shooter')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate("([c, a, b]) => { const s = window.__ar.settings; s.lastClass = c; s.loadouts[c] = { ...s.loadouts[c], primary: a, ...(b ? { secondary: b } : {}) }; }", [cls, primary, secondary])
    page.evaluate(click, 'PLAY NOW'); time.sleep(1)
    page.locator('tr.row').first.wait_for(timeout=15000)
    time.sleep(2)
    page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", name)
    time.sleep(0.5)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ig-screen').wait_for(timeout=120000)
    page.wait_for_function("() => !document.querySelector('.ld-root')", timeout=60000)
    time.sleep(2)
    page.evaluate(click, 'AUTO-ASSIGN'); time.sleep(3)
    page.wait_for_function("() => { const r = document.querySelector('.hud .respawn'); return r && r.classList.contains('hidden'); }", timeout=60000)
    time.sleep(2)
    page.mouse.click(640, 360)
    for i in range(6):
        page.mouse.down(); time.sleep(0.6)
        page.screenshot(path=os.path.join(out, f'70_fire_{cls}_{i}.png'))
        page.mouse.up(); time.sleep(0.4)
    browser.close()
