import crypto from "node:crypto";

const API_BASE = "https://api.circle.com";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error("Missing Circle environment variable: " + name);
  return value;
}

function encryptEntitySecret(entitySecret, publicKeyPem) {
  const plaintext = Buffer.from(entitySecret, "hex");
  return crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    plaintext
  ).toString("base64");
}

async function circleFetch(path, init = {}) {
  const apiKey = requireEnv("CIRCLE_API_KEY");
  const response = await fetch(API_BASE + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}

  if (!response.ok) {
    const code = body?.error?.code ?? body?.code ?? response.status;
    const message = body?.error?.message ?? body?.message ?? response.statusText;
    throw new Error("Circle API " + code + ": " + message);
  }

  return body;
}

export async function circleSignTransaction({ walletId, walletAddress, blockchain, transaction, memo }) {
  const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
  const keyResponse = await circleFetch("/v1/w3s/config/entity/publicKey");
  const publicKey = keyResponse?.data?.publicKey;
  if (!publicKey) throw new Error("Circle public key unavailable");

  const entitySecretCiphertext = encryptEntitySecret(entitySecret, publicKey);
  const payload = {
    entitySecretCiphertext,
    transaction,
    ...(walletId ? { walletId } : { walletAddress, blockchain }),
    ...(memo ? { memo } : {})
  };

  const response = await circleFetch("/v1/w3s/developer/sign/transaction", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const data = response?.data;
  if (!data?.signedTransaction) throw new Error("Circle returned no signed transaction");
  return data;
}
