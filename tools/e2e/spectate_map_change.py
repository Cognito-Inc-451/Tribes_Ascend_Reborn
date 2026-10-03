"""Spectator across a map change: stays connected and keeps spectating on the next map.
python tools/e2e/spectate_map_change.py
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

base = os.environ.get('AR_URL', 'http://localhost:7770')
name = f'SpecChange {int(time.time()) % 100000}'
body = {'name': name, 'mode': 'ctf', 'maxPlayers': 8, 'maps': ['katabatic'], 'mapSource': 'original', 'options': {'botsPerTeam': 2}}
req = urllib.request.Request(base + '/host', data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
try:
    print('host:', urllib.request.urlopen(req, timeout=20).read()[:80])
except urllib.error.HTTPError as e:
    print('host:', e.code, e.read()[:120])

state = """() => { const c = window.__ar.client(); if (!c) return { client: false, menu: !!document.querySelector('.ta-login, .ta-main, tr.row') };
  const me = c.pinfo(c.session.myId);
  return { client: true, map: c.map.id, team: me?.team, screen: !!document.querySelector('.ig-screen'), alive: c.pred.alive }; }"""
ok = True

def check(cond, label):
    global ok
    print(('ok   ' if cond else 'FAIL ') + label)
    ok &= bool(cond)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.goto(base + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'Spectator')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate(click, 'PLAY NOW'); time.sleep(1)
    page.locator('tr.row').first.wait_for(timeout=15000)
    time.sleep(2)
    page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", name)
    time.sleep(0.5)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ig-screen').wait_for(timeout=120000)
    page.wait_for_function("() => !document.querySelector('.ld-root')", timeout=60000)
    time.sleep(2)
    page.locator('button', has_text='SPECTATE').click()
    time.sleep(3)
    s = page.evaluate(state)
    print('first map:', s)
    check(s['team'] == 255, 'spectating on the first map')
    page.evaluate("() => { window.__oldClient = window.__ar.client(); const s = window.__oldClient.session; s.send({ t: 'callvote', kind: 'map', arg: 'katabatic' }); s.send({ t: 'vote', yes: true }); }")
    page.wait_for_function("() => { const c = window.__ar.client(); return (c && c !== window.__oldClient && !document.querySelector('.ld-root')) || (!c && !document.querySelector('.ld-root') && performance.now() > 0 && window.__oldClient.disposed); }", timeout=180000)
    time.sleep(4)
    s = page.evaluate(state)
    print('after map change:', s)
    check(s['client'], 'still connected after the map change')
    check(s.get('team') == 255, 'still spectating on the new map')
    check(not s.get('screen'), 'no team screen pops up')
    browser.close()
print('PASS' if ok else 'FAILED')
sys.exit(0 if ok else 1)
