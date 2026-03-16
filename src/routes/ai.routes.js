const express = require("express");
const { chatCompletion } = require("../services/ai.service");

const router = express.Router();

router.post("/chat", async (req, res) => {
  try {
    const { message, messages } = req.body || {};

    // Aceita "message" simples ou um array "messages"
    const finalMessages = Array.isArray(messages)
      ? messages
      : [
          { role: "system", content: "Você é um atendente da Pappi Pizza. Seja objetivo e cordial." },
          { role: "user", content: String(message || "") },
        ];

    if (!finalMessages.length) {
      return res.status(400).json({ error: "Envie 'message' ou 'messages'." });
    }

    const answer = await chatCompletion(finalMessages);

    return res.json({ answer });
  } catch (err) {
    console.error("AI /chat erro:", err);
    return res.status(500).json({ error: "Falha ao gerar resposta." });
  }
});

module.exports = router;
