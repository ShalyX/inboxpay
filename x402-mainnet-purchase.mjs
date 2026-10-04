import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { ExactEvmScheme } from '@x402/evm';
import { recoverTypedDataAddress } from 'viem';
import fs from 'node:fs/promises';

const WALLET_ID = '99d9eae6-8c88-5be4-b4e5-1d634d4c838e';
const WALLET_ADDRESS = '0xd3bb84b06dfdbeb0b4bf079dc9daaf7a68e55c7c';
const URL = 'https://arcusnetwork.co/api/demo/cat-fact';

const b64 = v => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const decode = v => JSON.parse(Buffer.from(v, 'base64').toString('utf8'));

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});

const first = await fetch(URL);

if (first.status !== 402) {
  throw new Error(`Expected 402, got ${first.status}`);
}

const paymentRequiredHeader = first.headers.get('PAYMENT-REQUIRED');
if (!paymentRequiredHeader) throw new Error('PAYMENT-REQUIRED missing');

const required = decode(paymentRequiredHeader);

const req = required.accepts?.find(
  x =>
    x.scheme === 'exact' &&
    x.network === 'eip155:5042' &&
    x.asset?.toLowerCase() ===
      '0x3600000000000000000000000000000000000000'
);

if (!req) throw new Error('No compatible Arc USDC requirement');

console.log(`x402 price: ${Number(req.amount) / 1_000_000} USDC`);
console.log(`PayTo: ${req.payTo}`);

const circleSigner = {
  address: WALLET_ADDRESS,
  signTypedData: async ({ domain, types, primaryType, message }) => {
    // x402 supplies the canonical EIP-712 payload. Circle's API requires
    // EIP712Domain to be explicitly declared, so add only that wrapper.
    const circleTypedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ...types,
      },
      domain,
      primaryType,
      message,
    };

    const signed = await circle.signTypedData({
      walletAddress: WALLET_ADDRESS,
      blockchain: 'ARC',
      data: JSON.stringify(circleTypedData, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value
      ),
      memo: 'InboxPay x402 purchase on Arc mainnet',
    });

    return signed.data?.signature;
  },
};

console.log('Signing with official @x402/evm ExactEvmScheme...');

const scheme = new ExactEvmScheme(circleSigner);
const payloadResult = await scheme.createPaymentPayload(2, req);

const authorization = payloadResult.payload.authorization;
let signature = payloadResult.payload.signature;

if (!signature) throw new Error('x402/Circle returned no signature');

console.log('Signature bytes:', (signature.length - 2) / 2);
console.log('Signature v byte:', signature.slice(-2));

if ((signature.length - 2) / 2 === 65 && ['00', '01'].includes(signature.slice(-2).toLowerCase())) {
  const v = Number.parseInt(signature.slice(-2), 16) + 27;
  signature = signature.slice(0, -2) + v.toString(16).padStart(2, '0');
  payloadResult.payload.signature = signature;
  console.log('Normalized v byte:', signature.slice(-2));
}

const typedData = {
  domain: {
    name: req.extra?.name ?? 'USDC',
    version: req.extra?.version ?? '2',
    chainId: 5042,
    verifyingContract: req.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
};

const recovered = await recoverTypedDataAddress({
  domain: typedData.domain,
  types: typedData.types,
  primaryType: typedData.primaryType,
  message: {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  },
  signature,
});

console.log('Recovered signer:', recovered);
console.log('Signer matches wallet:', recovered.toLowerCase() === WALLET_ADDRESS.toLowerCase());

if (recovered.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
  throw new Error('Circle signature does not recover to the ARC wallet address; stopping before payment.');
}

const paymentPayload = {
  x402Version: 2,
  resource: required.resource,
  accepted: req,
  payload: payloadResult.payload,
  ...(required.extensions
    ? { extensions: required.extensions }
    : {}),
};

console.log('Verifying payment directly with Arcus (no settlement)...');

const verify = await fetch('https://facilitator.arcusnetwork.co/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    x402Version: 2,
    paymentPayload,
    paymentRequirements: req,
  }),
});

const verifyBody = await verify.text();
console.log(`VERIFY HTTP ${verify.status}`);
console.log(verifyBody.slice(0, 2000));

if (!verify.ok) {
  throw new Error(`Arcus verify endpoint returned HTTP ${verify.status}`);
}

const verification = JSON.parse(verifyBody);
if (!verification.isValid) {
  throw new Error(`Arcus rejected signed payment: ${verification.invalidReason ?? 'unknown'} — ${verification.invalidMessage ?? ''}`);
}

console.log('Arcus verification PASSED.');

console.log('Submitting payment...');

const paid = await fetch(URL, {
  headers: {
    'PAYMENT-SIGNATURE': b64(paymentPayload),
  },
});

const body = await paid.text();

console.log(`HTTP ${paid.status}`);
console.log(body.slice(0, 1500));

const paymentResponse = paid.headers.get('PAYMENT-RESPONSE');

if (paymentResponse) {
  const settlement = decode(paymentResponse);
  console.log('SETTLEMENT');
  console.log(JSON.stringify(settlement, null, 2));

  await fs.writeFile(
    'x402-mainnet-receipt.json',
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        walletAddress: WALLET_ADDRESS,
        resource: URL,
        requirement: req,
        authorization,
        settlement,
        response: body,
      },
      null,
      2
    )
  );

  console.log(`TX_HASH=${settlement.transaction ?? 'NONE'}`);
}

if (!paid.ok) {
  throw new Error(`x402 request failed: HTTP ${paid.status}`);
}