"""Third-person animation captures (idle, run, strafe, jet, ski, fire).
Run with the stack up:  python tools/e2e/shots_anim.py [server-name-substring]
"""
import sys, time, os
from playwright.sync_api import sync_playwright

target = sys.argv[1] if len(sys.argv) > 1 else 'Originals'
out = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)
clip = {'x': 560, 'y': 380, 'width': 480, 'height': 480}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1600, 'height': 900})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.on('console', lambda m: print('console:', m.text) if m.type == 'error' else None)
    page.goto(os.environ.get('AR_URL', 'http://localhost:7770'))
    page.wait_for_load_state('networkidle')
    time.sleep(4)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'AnimTest')
    page.evaluate(click, 'SUBMIT'); time.sleep(2)
    page.evaluate(click, 'PLAY NOW'); time.sleep(1)
    page.locator('tr.row').first.wait_for(timeout=15000)
    time.sleep(1)
    page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", target)
    time.sleep(0.6)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ig-screen').wait_for(timeout=60000)
    time.sleep(1)
    page.evaluate(click, 'AUTO-ASSIGN')
    time.sleep(3)
    page.locator('#game canvas').click(force=True)
    page.mouse.click(800, 450)
    time.sleep(1)
    page.keyboard.press('KeyX'); time.sleep(4)

    def shot(name):
        page.screenshot(path=os.path.join(out, f'{name}.png'), clip=clip)

    shot('20_anim_idle')
    page.keyboard.down('KeyW'); time.sleep(1.0); shot('21_anim_run'); page.keyboard.up('KeyW')
    time.sleep(0.8)
    page.keyboard.down('KeyA'); time.sleep(0.9); shot('22_anim_strafe'); page.keyboard.up('KeyA')
    time.sleep(0.8)
    page.keyboard.down('KeyW'); page.mouse.down(button='right'); time.sleep(1.2); shot('23_anim_jet')
    page.mouse.up(button='right'); page.keyboard.up('KeyW')
    page.keyboard.down('Space'); time.sleep(2.5); shot('24_anim_ski'); page.keyboard.up('Space')
    time.sleep(1.5)
    page.mouse.down(); time.sleep(0.15); shot('25_anim_fire'); page.mouse.up()
    browser.close()
