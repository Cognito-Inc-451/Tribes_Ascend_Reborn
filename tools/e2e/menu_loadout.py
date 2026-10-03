"""Main-menu loadout screen: the window must not move or resize while hovering weapons; no item source is shown.
python tools/e2e/menu_loadout.py   (AR_URL = node, default http://localhost:7770)
"""
import os, sys, time
from playwright.sync_api import sync_playwright

base = os.environ.get('AR_URL', 'http://localhost:7770')
out = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)
ok = True

def check(cond, label):
    global ok
    print(('ok   ' if cond else 'FAIL ') + label)
    ok &= bool(cond)

rect = "() => { const w = document.querySelector('.loadout-view').getBoundingClientRect(); const l = [...document.querySelectorAll('.ta-choice')].slice(0, 3).map((c) => Math.round(c.getBoundingClientRect().y)); return JSON.stringify([Math.round(w.x), Math.round(w.y), Math.round(w.width), Math.round(w.height), l]); }"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.goto(base + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'MenuTester')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate(click, 'CLASSES'); time.sleep(1)
    page.evaluate(click, 'PATHFINDER'); time.sleep(4)
    page.locator('.loadout-view').wait_for(timeout=10000)
    before = page.evaluate(rect)
    choices = page.locator('.ta-choices .ta-choice')
    for i in range(min(choices.count(), 8)):
        choices.nth(i).hover()
        time.sleep(0.2)
        check(page.evaluate(rect) == before, f'layout unchanged hovering weapon {i}')
    page.screenshot(path=os.path.join(out, '64_menu_loadout.png'))
    text = page.evaluate("() => document.querySelector('.loadout-view').innerText")
    check('Source' not in text and 'SOURCE' not in text, 'no item source shown')
    page.evaluate("() => [...document.querySelectorAll('.ta-panel .ta-item')].find((b) => b.textContent.startsWith('SECONDARY WEAPON')).click()")
    time.sleep(3)
    page.screenshot(path=os.path.join(out, '65_menu_secondary.png'))
    browser.close()
print('PASS' if ok else 'FAILED')
sys.exit(0 if ok else 1)
