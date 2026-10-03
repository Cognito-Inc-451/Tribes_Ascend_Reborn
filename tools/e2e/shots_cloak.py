"""First-person cloak check: python tools/e2e/shots_cloak.py [server-substring]
Deploys as an Infiltrator, captures the view, turns the stealth pack on (C) and captures the cloaked arms/weapon.
"""
import sys, time, os
from playwright.sync_api import sync_playwright

target = sys.argv[1] if len(sys.argv) > 1 else 'Originals'
out = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.goto(os.environ.get('AR_URL', 'http://localhost:7770') + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'CloakTest')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate("() => { window.__ar.settings.lastClass = 'infiltrator'; }")
    page.evaluate(click, 'PLAY NOW'); time.sleep(1)
    page.locator('tr.row').first.wait_for(timeout=15000)
    time.sleep(1)
    page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", target)
    time.sleep(0.5)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ig-screen').wait_for(timeout=90000)
    time.sleep(1)
    page.evaluate(click, 'AUTO-ASSIGN')
    time.sleep(12)
    page.evaluate("() => { const c = window.__ar.client(); c.input.pitch = -0.15; }")
    time.sleep(2)
    state = "() => { const c = window.__ar.client(); return { cls: c.cls, alive: c.pred.alive, fp: !!c.viewModel.children[0]?.userData.fp, stealthed: !!c.viewModel.userData.stealthed }; }"
    print('before:', page.evaluate(state))
    page.screenshot(path=os.path.join(out, '60_cloak_off.png'))
    # Swiftshader runs at a few fps: hold the key long enough for a sim tick to see it.
    page.keyboard.down('KeyC'); time.sleep(1.5); page.keyboard.up('KeyC')
    time.sleep(3)
    print('after C:', page.evaluate(state))
    page.screenshot(path=os.path.join(out, '61_cloak_on.png'))
    browser.close()
