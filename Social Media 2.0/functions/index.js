const { onRequest } = require("firebase-functions/v2/https");

exports.api = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    res.status(404).json({
      error: "No API endpoints are configured."
    });
  }
);
