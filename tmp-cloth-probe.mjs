import { createCloth, stepCloth } from "./packages/client/src/render/cloth.js";
const c = createCloth(2, 1, 5, 3);
const wind = { x: 18, y: -6, z: 9 };
for (let i = 0; i < 600; i++) stepCloth(c, 1/60, i/60, wind, 3.2, 1.6);
let worst = 0, wl = -1;
for (let l = 0; l < c.links.length; l += 2) {
  const a = c.links[l]*3, b = c.links[l+1]*3;
  const d = Math.hypot(c.pos[b]-c.pos[a], c.pos[b+1]-c.pos[a+1], c.pos[b+2]-c.pos[a+2]);
  const r = c.restLen[l>>1];
  if (d/r > worst) { worst = d/r; wl = l>>1; }
}
console.log("worst", worst, "link", wl, "rest", c.restLen[wl>>1], "pinned", c.pinned[c.links[wl*2]], c.pinned[c.links[wl*2+1]]);
