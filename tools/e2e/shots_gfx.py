"""Graphics comparison captures: python tools/e2e/shots_gfx.py [server-substring] [preset ...]
Each preset (low/medium/high/ultra) or JSON settings override is applied through localStorage before loading.
"""
import json, sys, time, os
from playwright.sync_api import sync_playwright

target = sys.argv[1] if len(sys.argv) > 1 else 'Originals'
variants = sys.argv[2:] or ['low', 'high', 'ultra']
out = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)
PRESETS = ['low', 'medium', 'high', 'ultra']

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    for i, v in enumerate(variants):
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page.on('pageerror', lambda e: print('pageerror:', e))
        page.on('console', lambda m: print('console:', m.text[:300]) if m.type == 'error' else None)
        page.goto(os.environ.get('AR_URL', 'http://localhost:7770'))
        page.wait_for_load_state('networkidle')
        click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
        # Apply the preset through the settings UI so derived values match what players get.
        overrides = json.loads(v) if v.startswith('{') else {}
        preset = v if v in PRESETS else overrides.pop('quality', 'high')
        page.evaluate("""([q, o]) => {
            const k = 'ascend-reborn:settings:v1';
            const s = JSON.parse(localStorage.getItem(k) || '{}');
            s.__preset = q; Object.assign(s, o); localStorage.setItem(k, JSON.stringify(s));
        }""", [preset, overrides])
        page.reload(); page.wait_for_load_state('networkidle'); time.sleep(3)
        page.fill('.ta-login input[type=text]', f'Gfx{i}')
        page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
        page.evaluate(click, 'SETTINGS'); time.sleep(1)
        page.evaluate("(q) => { const s = [...document.querySelectorAll('select')][0]; s.value = q; s.dispatchEvent(new Event('change')); }", preset)
        time.sleep(0.5)
        if overrides:
            page.evaluate("""(o) => { const k = 'ascend-reborn:settings:v1'; const s = JSON.parse(localStorage.getItem(k)); Object.assign(s, o); localStorage.setItem(k, JSON.stringify(s)); }""", overrides)
            page.reload(); page.wait_for_load_state('networkidle'); time.sleep(3)
            page.fill('.ta-login input[type=text]', f'Gfx{i}')
            page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
        page.keyboard.press('Escape'); time.sleep(0.5)
        page.evaluate(click, 'PLAY NOW'); time.sleep(1)
        page.locator('tr.row').first.wait_for(timeout=15000)
        time.sleep(1)
        page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", target)
        time.sleep(0.5)
        page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
        page.locator('.ig-screen').wait_for(timeout=90000)
        time.sleep(1)
        page.evaluate(click, 'AUTO-ASSIGN')
        time.sleep(float(os.environ.get('AR_WAIT', '9')))
        name = v if v in PRESETS else f'custom{i}'
        page.screenshot(path=os.path.join(out, f'30_gfx_{name}.png'))
        page.close()
    browser.close()
