"""Debug: report baked-lighting state in a running client (tmp tool)."""
import json, sys, time, os
from playwright.sync_api import sync_playwright

base = os.environ.get('AR_URL', 'http://localhost:7770')
name = sys.argv[1] if len(sys.argv) > 1 else 'Spots katabatic'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 960, 'height': 540})
    page.on('pageerror', lambda e: print('pageerror:', e))
    page.on('console', lambda m: print('console:', m.text) if m.type in ('error', 'warning') else None)
    page.goto(base + '/?debug')
    page.wait_for_load_state('networkidle')
    time.sleep(3)
    click = "(t) => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith(t)).click()"
    page.fill('.ta-login input[type=text]', 'LmDebug')
    page.evaluate(click, 'SUBMIT'); time.sleep(1.5)
    page.evaluate(click, 'PLAY NOW'); time.sleep(1)
    page.locator('tr.row').first.wait_for(timeout=15000)
    time.sleep(2)
    page.evaluate("(t) => [...document.querySelectorAll('tr.row')].find(x => x.textContent.includes(t)).click()", name)
    time.sleep(0.5)
    page.evaluate("() => [...document.querySelectorAll('button')].find(b => b.textContent === 'JOIN').click()")
    page.locator('.ig-screen').wait_for(timeout=120000)
    time.sleep(15)
    info = page.evaluate("""() => {
      const c = window.__ar.client(), v = c.view, map = c.map;
      const inst = map.instances || [];
      let ims = 0, lmIms = 0, mats = 0, lmMats = 0, lmLoaded = 0;
      v.group.traverse((o) => { if (o.isInstancedMesh) { ims++; if (o.geometry.attributes.lmST) lmIms++; } });
      for (const m of v.texMats.values()) { mats++; if (m.userData.lm) lmMats++; if (m.lightMap) lmLoaded++; }
      return { settings: window.__ar.settings.bakedLighting, instances: inst.length, withLm: inst.filter((i) => i.lm).length, uv2: (map.meshes || []).filter((m) => m.uv2).length,
        textures: (map.textures || []).filter((t) => t.startsWith('LM_')), ims, lmIms, mats, lmMats, lmLoaded };
    }""")
    print(json.dumps(info))
    browser.close()
