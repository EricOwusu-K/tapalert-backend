import express from "express";
import cors from "cors";
import admin from "firebase-admin";

// Expect the whole service account JSON in one env var
// e.g. FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(sa),
});

const db = admin.firestore();
const app = express();
app.use(cors());                 // allow web & mobile calls
app.use(express.json());         // parse JSON bodies

// POST /send-alert
// Body: { "toUserId": "...", "title": "...", "body": "...", "data": { ... } }
app.post("/send-alert", async (req, res) => {
  try {
    const { toUserId, title, body, data } = req.body || {};
    if (!toUserId || !title || !body) {
      return res.status(400).json({ error: "toUserId, title, body are required" });
    }

    const userDoc = await db.collection("users").doc(toUserId).get();
    if (!userDoc.exists) return res.status(404).json({ error: "Recipient not found" });

    const tokens = userDoc.get("fcmTokens") || [];
    if (!tokens.length) return res.status(200).json({ sent: 0, results: [], note: "No tokens" });

    // Prefer sendEachForMulticast to handle multiple devices
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: (data && Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)]))) || {},
    });

    // Auto-clean invalid tokens
    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const t = tokens[i];
        const code = r.error?.code || "";
        if (code.includes("registration-token-not-registered")) invalid.push(t);
      }
    });
    if (invalid.length) {
      await db.collection("users").doc(toUserId).update({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalid),
      });
    }

    return res.status(200).json({ sent: resp.successCount, failed: resp.failureCount });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Internal error" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`FCM service listening on :${port}`));
