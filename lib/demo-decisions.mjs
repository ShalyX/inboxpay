export const demoDecisions = {
  evaluatedAt: "2026-10-02T00:22:21.455Z",
  count: 2,
  invoices: [
    {
      vendor: "Acme Test Hosting",
      invoiceNumber: "TA-GMAIL-0001",
      amount: 0.5,
      currency: "USDC",
      dueDate: "October 2, 2026",
      agentDecision: "PAY_NOW",
      decisionReasons: ["Invoice is due today or overdue and passed verification."],
      extraction: { source: "gmail-invoice-text", parser: "deterministic-regex-v2", confidence: "high" },
      sourceCount: 1,
      sources: ["gmail-email"],
      paymentId: "0x9bd8f2928a565c6809d11ee236496de706a2da69a94416540c7b7b59413941cf"
    },
    {
      vendor: "Servarica",
      invoiceNumber: "231842",
      amount: 5,
      currency: "USD",
      dueDate: "July 27, 2026",
      agentDecision: "HOLD",
      decisionReasons: ["Settlement currency is USD; Arc payment rail requires USDC."],
      extraction: { source: "gmail-invoice-text", parser: "deterministic-regex-v2", confidence: "high" },
      sourceCount: 2,
      sources: ["gmail-email", "gmail-pdf"]
    }
  ]
};
