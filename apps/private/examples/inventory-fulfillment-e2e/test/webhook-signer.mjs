// Test-only: signs webhook deliveries the way the gateway does, so --self-test and npm test can
// exercise WebhookReceiver offline. A production app never signs; it only verifies.
import { createHash, createSign, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

/**
 * Test-only signer for RFC 9421 webhook deliveries, mirroring what the gateway sends
 * (rsa-v1_5-sha256 or ed25519 over @method, @target-uri and content-digest). Production apps never sign.
 */
export function createTestWebhookSigner({ endpoint, keyid = 'webhook-signing-1', alg = 'rsa-v1_5-sha256' } = {}) {
  const isEd = alg === 'ed25519';
  const { publicKey, privateKey } = isEd ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: keyid, alg: isEd ? 'EdDSA' : 'RS256', use: 'sig' };
  return {
    jwk,
    sign(event, { created = Math.floor(Date.now() / 1000) } = {}) {
      const body = JSON.stringify(event);
      const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
      const params = `("@method" "@target-uri" "content-digest");created=${created};keyid="${keyid}";alg="${alg}"`;
      const base = `"@method": POST\n"@target-uri": ${endpoint}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
      const signature = isEd
        ? cryptoSign(null, Buffer.from(base), privateKey).toString('base64')
        : createSign('sha256').update(base).sign(privateKey, 'base64');
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-digest': digest, 'signature-input': `sig1=${params}`, signature: `sig1=:${signature}:` },
        body,
      };
    },
  };
}
