"""Capture the loading screen and the class-loadout skin picker. Usage: python shots_loading.py [server-substring] [out-dir]"""
import sys, time, os
from playwright.sync_api import sync_playwright

target = sys.argv[1] if len(sys.argv) > 1 else 'Capture and Hold'
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1600, 'height': 900})
    page.goto(os.environ.get('AR_URL', 'http://localhost:7770'))
    page.wait_for_load_state('networkidle')
    time.sleep(4)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'ShotTest')
    page.evaluate(click, 'SUBMIT')
    time.sleep(2)
    # Hold map downloads for a few seconds so the loading screen can be captured.
    def slow(route):
        time.sleep(4)
        route.continue_()
    page.route('**/map/*.arm.gz', slow)
    page.evaluate(click, 'CLASSES'); time.sleep(1.2)
    page.evaluate(click, 'RAIDER'); time.sleep(1.2)
    page.evaluate(click, 'SKIN'); time.sleep(2.5)
    page.screenshot(path=os.path.join(out, '11_skins.png'))
    page.keyboard.press('KeyM'); time.sleep(0.5)
    page.evaluate(click, 'PLAY NOW'); time.sleep(0.5)
    rows = page.locator('tr.row')
    rows.first.wait_for(timeout=15000)
    time.sleep(1)
    page.evaluate("(t) => { const r = [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)); r.click(); }", target)
    time.sleep(0.5)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ld-root').wait_for(timeout=10000)
    time.sleep(0.3)
    page.screenshot(path=os.path.join(out, '12_loading.png'))
    page.locator('.ig-screen').wait_for(timeout=60000)
    time.sleep(6)
    page.screenshot(path=os.path.join(out, '13_prespawn.png'))
    browser.close()
