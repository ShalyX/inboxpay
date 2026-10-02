export default function handler(req, res) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("InboxPay route not found");
}
