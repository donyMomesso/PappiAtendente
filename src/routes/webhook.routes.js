const express = require("express");
const ENV = require("../config/env");

const router = express.Router();

// ===========================================
// Verificação do Webhook do WhatsApp (Meta)
// ===========================================
router.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!ENV.WEBHOOK_VERIFY_TOKEN) {
      console.error("❌ WEBHOOK_VERIFY_TOKEN não configurado.");
      return res.sendStatus(500);
    }

    if (mode === "subscribe" && token === ENV.WEBHOOK_VERIFY_TOKEN) {
      console.log("✅ Webhook verificado com sucesso.");
      return res.status(200).send(challenge);
    }

    console.warn("⚠️ Tentativa inválida de verificação do webhook.");
    return res.sendStatus(403);

  } catch (error) {
    console.error("🔥 Erro na verificação do webhook:", error);
    return res.sendStatus(500);
  }
});

module.exports = router;
