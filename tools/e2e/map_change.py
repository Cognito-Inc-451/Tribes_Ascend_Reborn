"""Join / Esc / map change regression:
- the team screen on join leaves the mouse free (no Esc needed to click a team),
- losing the pointer lock (what Esc does) opens the pause menu at once,
- after a map change no team/class screen opens, one click respawns and the player can move.
python tools/e2e/map_change.py
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

base = os.environ.get('AR_URL', 'http://localhost:7770')
name = f'MapChange {int(time.time()) % 100000}'
body = {'name': name, 'mode': 'ctf', 'maxPlayers': 8, 'maps': ['katabatic'], 'mapSource': 'original', 'options': {'botsPerTeam': 0}}
req = urllib.request.Request(base + '/host', data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
try:
    print('host:', urllib.request.urlopen(req, timeout=20).read()[:80])
except urllib.error.HTTPError as e:
    print('host:', e.code, e.read()[:120])

state = """() => { const c = window.__ar.client(); if (!c) return null; const me = c.session.latest?.players.find((p) => p.id === c.session.myId);
  return { map: c.map.id, alive: c.pred.alive, screen: !!document.querySelector('.ig-screen'), paused: [...document.querySelectorAll('h2')].some((h) => h.textContent === 'Paused'),
    pos: me ? [me.pos.x, me.pos.y, me.pos.z].map((v) => +v.toFixed(1)) : null, respawn: document.querySelector('.hud .respawn')?.textContent, locked: document.pointerLockElement != null }; }"""
ok = True

def check(cond, label):
    global ok
    print(('ok   ' if cond else 'FAIL ') + label)
    ok &= bool(cond)

def moved(page, label):
    a = page.evaluate(state)['pos']
    page.keyboard.down('KeyW'); time.sleep(4); page.keyboard.up('KeyW'); time.sleep(1)
    b = page.evaluate(state)['pos']
    d = ((a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5
    check(d > 0.5, f'{label}: moved {d:.1f} m')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.goto(base + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'MapChanger')
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
    s = page.evaluate(state)
    check(s['screen'] and not s['locked'], f"team screen on join leaves the mouse free (locked={s['locked']})")
    page.locator('button', has_text='AUTO-ASSIGN').click()
    page.wait_for_function("() => window.__ar.client()?.pred.alive", timeout=30000)
    time.sleep(2)
    print('first map:', page.evaluate(state))
    moved(page, 'first map')
    page.mouse.click(640, 360); time.sleep(1)
    page.evaluate("() => document.exitPointerLock()"); time.sleep(1.5)
    check(page.evaluate(state)['paused'], 'one Esc (lost pointer lock) opens the pause menu')
    page.locator('button', has_text='Resume').click(); time.sleep(1)
    s = page.evaluate(state)
    check(not s['paused'] and s['locked'], f"Resume closes it and grabs the mouse (locked={s['locked']})")
    # Same map again: a real reload (new match and client) without swiftshader crawling on a heavier map.
    page.evaluate("() => { window.__oldClient = window.__ar.client(); const s = window.__oldClient.session; s.send({ t: 'callvote', kind: 'map', arg: 'katabatic' }); s.send({ t: 'vote', yes: true }); }")
    page.wait_for_function("() => { const c = window.__ar.client(); return c && c !== window.__oldClient && c.map.id === 'katabatic' && !document.querySelector('.ld-root'); }", timeout=180000)
    time.sleep(3)
    s = page.evaluate(state)
    print('after map change:', s)
    check(not s['screen'] and not s['paused'], 'no team/class screen after the map change')
    d = page.evaluate("() => ({ seq: window.__ar.client().pred.seq, oldSeq: window.__oldClient.pred.seq })")
    check(d['seq'] >= d['oldSeq'], f"input sequence carried over the map change ({d['oldSeq']} -> {d['seq']})")
    t0 = time.time()
    page.mouse.click(640, 360)
    page.wait_for_function("() => window.__ar.client()?.pred.alive", timeout=30000)
    print(f'spawned on the new map {time.time() - t0:.1f} s after the click (swiftshader compiles shaders first)')
    moved(page, 'second map')
    # Click during the respawn countdown: queued, so we deploy when it ends (5 s), not via the 10 s fallback.
    page.evaluate("() => window.__ar.client().session.send({ t: 'suicide' })")
    page.wait_for_function("() => !window.__ar.client()?.pred.alive", timeout=15000)
    t0 = time.time()
    time.sleep(1)
    page.mouse.click(640, 360)
    time.sleep(1)
    print('countdown:', page.evaluate(state)['respawn'])
    page.wait_for_function("() => window.__ar.client()?.pred.alive", timeout=30000)
    dt = time.time() - t0
    check(dt < 9, f'a click during the countdown respawned {dt:.1f} s after death (fallback would be 15 s)')
    browser.close()
print('RESULT', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
