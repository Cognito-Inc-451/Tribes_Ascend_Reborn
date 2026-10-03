"""Effect-by-effect captures through the ?debug hook: python tools/e2e/shots_fx.py [server-substring]
Joins, deploys, then aims at the sun / the ground and toggles god rays, AO, DOF, grading and motion blur live.
"""
import sys, time, os, math
from playwright.sync_api import sync_playwright

target = sys.argv[1] if len(sys.argv) > 1 else 'Originals'
out = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(out, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.on('console', lambda m: print('console:', m.text[:300]) if m.type == 'error' else None)
    page.goto(os.environ.get('AR_URL', 'http://localhost:7770') + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'FxTest')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate(click, 'PLAY NOW'); time.sleep(1)
    page.locator('tr.row').first.wait_for(timeout=15000)
    time.sleep(1)
    page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", target)
    time.sleep(0.5)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ig-screen').wait_for(timeout=90000)
    time.sleep(1)
    page.evaluate(click, 'AUTO-ASSIGN')
    time.sleep(8)
    page.evaluate("() => document.querySelectorAll('.pause-menu, .ig-screen').forEach(e => e.remove())")

    def setfx(js):
        page.evaluate("(js) => { const s = window.__ar.settings; Function('s', js)(s); window.__ar.gfx(); }", js)
        time.sleep(2.5)

    def aim(yaw, pitch):
        page.evaluate("([y, p]) => { const c = window.__ar.client(); c.input.yaw = y; c.input.pitch = p; }", [yaw, pitch])
        time.sleep(1.2)

    def shot(name):
        page.screenshot(path=os.path.join(out, f'{name}.png'))

    sun = page.evaluate("() => { const d = window.__ar.client().view.sunDirection; return [d.x, d.y, d.z]; }")
    sun_yaw = math.atan2(-sun[0], -sun[2])
    base = "s.post='light'; s.hdr=true; s.bloom=true; s.ao='high'; s.godrays=true; s.volumetricFog=true; s.dof=false; s.motionBlur=0; s.filmGrain=0; s.chromatic=0;"
    setfx(base)
    aim(sun_yaw, min(0.5, math.asin(max(-1, min(1, sun[1]))) * 0.8))
    shot('31_fx_sun_godrays')
    setfx(base + "s.godrays=false; s.volumetricFog=false;")
    shot('31_fx_sun_plain')
    aim(sun_yaw + math.pi, -0.35)
    setfx(base)
    shot('32_fx_ao_on')
    setfx(base + "s.ao='off';")
    shot('32_fx_ao_off')
    setfx(base + "s.dof=true; s.filmGrain=0.6; s.chromatic=0.6; s.grade='cinematic'; s.temperature=0.3;")
    shot('33_fx_style')
    setfx(base + "s.post='off';")
    shot('34_fx_post_off')
    browser.close()
