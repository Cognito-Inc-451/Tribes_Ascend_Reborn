"""Third-person capture of your own character: python tools/e2e/tp_shot.py <map> [class] [yaw-offset-seconds]
Looks for lighting/shadow problems on player models.
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

map_id = sys.argv[1] if len(sys.argv) > 1 else 'stonehenge'
cls = sys.argv[2] if len(sys.argv) > 2 else 'soldier'
base = os.environ.get('AR_URL', 'http://localhost:7770')
out = os.path.join(os.path.dirname(__file__), 'shots')
name = f'TP {int(time.time()) % 100000}'
body = {'name': name, 'mode': 'ctf', 'maxPlayers': 8, 'maps': [map_id], 'mapSource': 'original', 'options': {'botsPerTeam': 3}}
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
    page.fill('.ta-login input[type=text]', 'Tpshot')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate("(c) => { window.__ar.settings.lastClass = c; }", cls)
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
    page.keyboard.press('KeyX')
    for i in range(3):
        time.sleep(3)
        page.screenshot(path=os.path.join(out, f'71_tp_{map_id}_{i}.png'))
    browser.close()
