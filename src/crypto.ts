import {
  generateKeyPairSync,
  sign,
  verify,
  createPublicKey,
  createPrivateKey,
  createHash,
  KeyObject,
} from 'node:crypto';

export interface PemKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateEd25519(): PemKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey({ key: pem, format: 'pem', type: 'spki' });
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
}

/** Stable, copy-pasteable identifier for a public key: 12 hex chars, grouped 4-4-4. */
export function fingerprint(publicKeyPem: string): string {
  // Hash the canonical SPKI DER bytes (independent of PEM whitespace).
  const der = publicKeyFromPem(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  const h = createHash('sha256').update(der).digest('hex');
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

export interface SignedRequestPayload {
  method: string;     // upper-case HTTP verb
  path: string;       // raw path with query string
  timestampMs: number;
  nonce: string;      // 32-hex random
  body: string;       // raw request body, "" if none
}

export function canonicalize(p: SignedRequestPayload): string {
  const bodyHash = createHash('sha256').update(p.body, 'utf8').digest('hex');
  return [p.method.toUpperCase(), p.path, String(p.timestampMs), p.nonce, bodyHash].join('\n');
}

export function signRequest(privateKeyPem: string, p: SignedRequestPayload): string {
  const data = Buffer.from(canonicalize(p), 'utf8');
  const sig = sign(null, data, privateKeyFromPem(privateKeyPem));
  return sig.toString('base64');
}

export function verifyRequest(
  publicKeyPem: string,
  p: SignedRequestPayload,
  signatureB64: string,
): boolean {
  try {
    const data = Buffer.from(canonicalize(p), 'utf8');
    const sig = Buffer.from(signatureB64, 'base64');
    return verify(null, data, publicKeyFromPem(publicKeyPem), sig);
  } catch {
    return false;
  }
}

export function hashCode(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}
