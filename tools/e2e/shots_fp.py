"""First-person captures: python tools/e2e/shots_fp.py [server-substring]
Deploys, waits for the TA arms/weapon, then captures idle, firing and the secondary weapon.
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
    page.on('console', lambda m: print('console:', m.text[:300]) if m.type == 'error' else None)
    page.goto(os.environ.get('AR_URL', 'http://localhost:7770') + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'FpTest')
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
    time.sleep(12)
    page.evaluate("() => document.querySelectorAll('.pause-menu, .ig-screen').forEach(e => e.remove())")
    page.evaluate("() => { const c = window.__ar.client(); c.input.pitch = -0.1; }")
    time.sleep(1)
    print('fp loaded:', page.evaluate("() => !!window.__ar.client().viewModel.children[0]?.userData.fp"))
    page.evaluate("() => window.__ar.client().viewModel.children[0]?.userData.fp?.player.play('Idle', true, 0)")
    time.sleep(4)
    print('readout:', page.evaluate("""() => { const c = window.__ar.client(); const fp = c.viewModel.children[0]?.userData.fp; if (!fp) return 'none';
        const cam = window.__ar.renderer.camera; const m = fp.ammo.mesh; const p = m.getWorldPosition(m.position.clone().set(0,0,0)); cam.worldToLocal(p);
        return { placed: fp.placed, parent: m.parent?.name, cam: [p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3)], playing: fp.player.playing }; }"""))
    page.screenshot(path=os.path.join(out, '40_fp_idle.png'))
    page.evaluate("() => window.__ar.client().viewModel.children[0]?.userData.fp?.player.play('Fire', false, 0.04)")
    time.sleep(0.12)
    page.screenshot(path=os.path.join(out, '41_fp_fire.png'))
    page.evaluate("() => window.__ar.client().viewModel.children[0]?.userData.fp?.player.play('reload', false, 0.1)")
    time.sleep(0.6)
    page.screenshot(path=os.path.join(out, '42_fp_reload.png'))
    page.keyboard.press('Digit2'); time.sleep(3)
    print('after switch:', page.evaluate("() => { const fp = window.__ar.client().viewModel.children[0]?.userData.fp; return fp ? fp.player.playing : 'no fp'; }"))
    page.screenshot(path=os.path.join(out, '43_fp_secondary.png'))
    time.sleep(6)
    print('later:', page.evaluate("() => { const fp = window.__ar.client().viewModel.children[0]?.userData.fp; return fp ? fp.player.playing : 'no fp'; }"))
    page.evaluate("() => window.__ar.client().viewModel.children[0]?.userData.fp?.player.play('Idle', true, 0)")
    time.sleep(3)
    print('readout:', page.evaluate("""() => { const fp = window.__ar.client().viewModel.children[0]?.userData.fp; if (!fp) return 'none';
        const cam = window.__ar.renderer.camera; const m = fp.ammo.mesh; const p = m.getWorldPosition(m.position.clone().set(0,0,0)); cam.worldToLocal(p);
        return { placed: fp.placed, cam: [p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3)] }; }"""))
    page.screenshot(path=os.path.join(out, '44_fp_secondary_idle.png'))
    browser.close()
