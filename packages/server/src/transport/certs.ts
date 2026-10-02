import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as x509 from '@peculiar/x509';

export interface CertBundle { cert: string; key: string; hash: string | null }

/**
 * WebTransport with serverCertificateHashes requires ECDSA P-256 and <= 14 days validity.
 * Operators can supply a real certificate instead (hash is then null and normal PKI applies).
 */
export async function getCertificate(certFile?: string, keyFile?: string, host = 'localhost'): Promise<CertBundle> {
  if (certFile && keyFile && existsSync(certFile) && existsSync(keyFile)) {
    return { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8'), hash: null };
  }
  x509.cryptoProvider.set(webcrypto as never);
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Date.now().toString(16),
    name: `CN=${host}`,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + 13 * 24 * 3600 * 1000),
    signingAlgorithm: alg,
    keys: keys as never,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: host }, { type: 'dns', value: 'localhost' }, { type: 'ip', value: '127.0.0.1' }])],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  const der = new Uint8Array(cert.rawData);
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', der));
  return { cert: cert.toString('pem'), key: keyPem, hash: Buffer.from(digest).toString('hex') };
}
