export function circleCredentials(blockchain) {
  if (blockchain === "ARC") {
    return {
      apiKey: process.env.CIRCLE_LIVE_API_KEY || process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_LIVE_ENTITY_SECRET || process.env.CIRCLE_ENTITY_SECRET
    };
  }

  return {
    apiKey: process.env.CIRCLE_TEST_API_KEY,
    entitySecret: process.env.CIRCLE_TEST_ENTITY_SECRET
  };
}

export function requireCircleCredentials(blockchain) {
  const credentials = circleCredentials(blockchain);
  if (!credentials.apiKey || !credentials.entitySecret) {
    throw new Error(
      "Circle credentials are not configured for " + blockchain +
      ". Production infrastructure must provide the matching Circle API key and entity secret."
    );
  }
  return credentials;
}
