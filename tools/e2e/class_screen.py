"""In-game class screen: skin/voice slots, preview, stable layout on hover, cosmetics reach the server.
python tools/e2e/class_screen.py   (AR_URL = node, default http://localhost:7770)
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

base = os.environ.get('AR_URL', 'http://localhost:7770')
out = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)
name = f'ClassScreen {int(time.time()) % 100000}'
body = {'name': name, 'mode': 'ctf', 'maxPlayers': 8, 'maps': ['katabatic'], 'mapSource': 'original', 'options': {'botsPerTeam': 1}}
req = urllib.request.Request(base + '/host', data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
try:
    print('host:', urllib.request.urlopen(req, timeout=20).read()[:80])
except urllib.error.HTTPError as e:
    print('host:', e.code, e.read()[:120])
ok = True

def check(cond, label):
    global ok
    print(('ok   ' if cond else 'FAIL ') + label)
    ok &= bool(cond)

rect = "() => { const r = document.querySelector('.ig-cols').getBoundingClientRect(); const l = [...document.querySelectorAll('.ig-col')].map((c) => { const b = c.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; }); return JSON.stringify([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), l]); }"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.goto(base + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'ClassTester')
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
    page.evaluate(click, 'AUTO-ASSIGN'); time.sleep(3)
    page.keyboard.press('KeyI')
    page.locator('.ig-cols').wait_for(timeout=10000)
    time.sleep(4)
    page.screenshot(path=os.path.join(out, '60_class_screen.png'))
    check(page.locator('.ig-preview canvas').count() == 1, 'preview canvas on the in-game class screen')
    slots = page.evaluate("() => [...document.querySelectorAll('.ig-col')[1].querySelectorAll('.ta-item .t')].map((e) => e.textContent)")
    print('slots', slots)
    check('SKIN' in slots and 'VOICE' in slots, 'skin and voice slots')
    # Hovering weapons of different stat sizes must not move or resize anything.
    before = page.evaluate(rect)
    choices = page.locator('.ig-col').nth(2).locator('.ta-choice')
    n = choices.count()
    for i in range(min(n, 8)):
        choices.nth(i).hover()
        time.sleep(0.15)
        check(page.evaluate(rect) == before, f'layout unchanged hovering weapon {i}')
    page.screenshot(path=os.path.join(out, '61_class_hover.png'))
    page.evaluate("() => [...document.querySelectorAll('.ig-col')[1].querySelectorAll('.ta-item')].find((b) => b.textContent.startsWith('VOICE')).click()")
    time.sleep(2)
    page.screenshot(path=os.path.join(out, '62_class_voice.png'))
    voices = page.evaluate("() => [...document.querySelectorAll('.ig-col')[2].querySelectorAll('.ta-choice')].map((e) => e.textContent)")
    print('voices', voices[:6])
    pick = next((v for v in voices if 'SYNTH' not in v), voices[-1])
    pick = voices[1] if len(voices) > 1 else voices[0]
    page.evaluate("(t) => [...document.querySelectorAll('.ig-col')[2].querySelectorAll('.ta-choice')].find((b) => b.textContent === t).click()", pick)
    time.sleep(2)
    chosen = page.evaluate("() => { const c = window.__ar.client(); return c.pinfo(c.session.myId)?.cosmetics.voice; }")
    saved = page.evaluate("() => JSON.parse(localStorage.getItem('ascend-reborn:settings:v1')).cosmetics.voice")
    print('voice on server', chosen, 'saved', saved)
    check(chosen == saved, 'voice change reached the server')
    page.evaluate("() => [...document.querySelectorAll('.ig-col')[1].querySelectorAll('.ta-item')].find((b) => b.textContent.startsWith('SKIN')).click()")
    time.sleep(2)
    page.screenshot(path=os.path.join(out, '63_class_skin.png'))
    browser.close()
print('PASS' if ok else 'FAILED')
sys.exit(0 if ok else 1)
