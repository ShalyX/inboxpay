// Offline record validation only. No authentication, database writes or deletion.
export function validateGmailRemovalRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid request record');
  const fields = [
    'version', 'requestId', 'businessId', 'ownerUserId', 'operatorId', 'scope',
    'receivedAt', 'identityVerifiedAt', 'scopeApprovedAt', 'appliedAt', 'checkedAt',
    'identityMethod', 'activeTokensRemoved', 'providerMetadataRemoved',
    'financialRecordsPreserved', 'paymentAuthorityChanged', 'googleGrantRevoked', 'backupStatus',
  ];
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) throw new Error('Unexpected record field; keep personal data and credentials out');
  }
  if (record.version !== 1) throw new Error('Unsupported record version');
  for (const field of ['requestId', 'businessId', 'ownerUserId', 'operatorId']) {
    if (typeof record[field] !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record[field])) {
      throw new Error(`Invalid ${field}`);
    }
  }
  if (record.scope !== 'gmail_credentials') throw new Error('Unsupported request scope');
  if (record.identityMethod !== 'signed_in_owner') throw new Error('Unsupported identity check; use the separate recovery process');
  if (!record.scopeApprovedAt) throw new Error('Explicit scope approval is required');
  let previous = -Infinity;
  for (const field of ['receivedAt', 'identityVerifiedAt', 'scopeApprovedAt', 'appliedAt', 'checkedAt']) {
    const value = record[field];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace('Z', '.000Z')) {
      throw new Error(`Invalid timestamp: ${field}`);
    }
    const time = Date.parse(value);
    if (time < previous) throw new Error('Request timestamps must be chronological');
    previous = time;
  }
  if (record.activeTokensRemoved !== true || record.providerMetadataRemoved !== true) throw new Error('Active removal is not verified');
  if (record.financialRecordsPreserved !== true || record.paymentAuthorityChanged !== false) throw new Error('Request exceeded its financial boundary');
  if (record.googleGrantRevoked !== false) throw new Error('This process does not prove Google grant revocation');
  if (record.backupStatus !== 'expiry_pending') throw new Error('This process does not prove backup erasure');
  // These are record consistency checks, not authentication or independent evidence.
  return {
    activeRemovalRecorded: true,
    backupErasureProven: false,
    workspaceDeletionComplete: false,
    googleGrantRevocationProven: false,
  };
}
