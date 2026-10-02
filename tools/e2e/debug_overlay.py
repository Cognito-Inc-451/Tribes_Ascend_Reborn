import sys, time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = b.new_page(viewport={'width': 1600, 'height': 900})
    page.goto('http://localhost:5173'); page.wait_for_load_state('networkidle')
    page.locator('tr.row', has_text=sys.argv[1] if len(sys.argv) > 1 else 'Procedural').first.click()
    page.get_by_text('Join Server').click()
    page.locator('.class-grid').wait_for(timeout=60000)
    time.sleep(1)
    ov = page.locator('.overlay-center')
    print('overlays:', ov.count())
    for i in range(ov.count()):
        print(i, ov.nth(i).inner_text()[:80].replace('\n', ' '), ov.nth(i).evaluate('e => e.parentElement.className + " z=" + getComputedStyle(e).zIndex'))
    print(page.evaluate("() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='Deploy'); const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return el.className + ' | ' + el.tagName; }"))
    b.close()
