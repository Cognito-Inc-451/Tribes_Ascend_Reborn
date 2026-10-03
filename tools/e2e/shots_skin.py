"""Capture the Mercenary skin preview. Usage: python shots_skin.py [class] [skin-label]"""
import sys, time, os
from playwright.sync_api import sync_playwright

cls = sys.argv[1] if len(sys.argv) > 1 else 'RAIDER'
skin = sys.argv[2] if len(sys.argv) > 2 else 'MERCENARY'
out = os.path.join(os.path.dirname(__file__), 'shots')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1600, 'height': 900})
    page.on('console', lambda m: print('console:', m.type, m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.goto(os.environ.get('AR_URL', 'http://localhost:7770'))
    page.wait_for_load_state('networkidle')
    time.sleep(4)
    click_js = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t || b.textContent.startsWith(t)).click()"
    def click(t):
        try:
            page.evaluate(click_js, t)
        except Exception:
            print('buttons:', page.evaluate("() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).slice(0, 40)"))
            raise
    page.fill('.ta-login input[type=text]', 'SkinTest')
    click('SUBMIT'); time.sleep(2)
    click('CLASSES'); time.sleep(1.2)
    click(cls); time.sleep(1.2)
    click('SKIN'); time.sleep(1.5)
    print('choices:', page.evaluate("() => [...document.querySelectorAll('.ta-choice')].map(b => b.textContent.trim())"))
    page.evaluate("(t) => ([...document.querySelectorAll('.ta-choice')].find(b => b.textContent.trim() === t) ?? document.querySelector('.ta-choice')).click()", skin)
    time.sleep(float(os.environ.get('AR_WAIT', '4')))
    page.screenshot(path=os.path.join(out, f'14_skin_{cls.lower()}.png'), clip={'x': 1000, 'y': 270, 'width': 560, 'height': 420})
    browser.close()
