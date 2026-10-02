import { getCertificate } from '../src/transport/certs.js';
import { startWtServer } from '../src/transport/wt.js';

// Dev check: can this machine open a WebTransport (HTTP/3) listener?
const t0 = Date.now();
const c = await getCertificate(undefined, undefined, 'localhost');
console.log('cert ok', Date.now() - t0, 'ms');
const h = await startWtServer(Number(process.argv[2] ?? 7799), c.cert, c.key, () => console.log('session!'), console.log);
console.log('webtransport listener', h ? 'OK' : 'unavailable', Date.now() - t0, 'ms');
h?.stop();
process.exit(0);
