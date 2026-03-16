const express = require("express");
const ENV = require("../config/env");
const { saveRules } = require("../services/rulesdb.service");

const router = express.Router();

function guard(req, res, next) {
  const k = req.headers["x-admin-key"];
  if (!ENV.ATTENDANT_API_KEY || k !== ENV.ATTENDANT_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Atualiza regras no banco (sem redeploy)
router.post("/rules", guard, async (req, res) => {
  try {
    const { mode, text } = req.body || {};
    if (!text) return res.status(400).json({ error: "text obrigatório" });

    const m = String(mode || "BASE").toUpperCase();

    const prisma = req.app.get("prisma");
    const saved = await saveRules({ prisma, mode: m, text });

    res.json({ ok: true, key: saved.key });
  } catch (e) {
    console.error("admin /rules erro:", e);
    res.status(500).json({ error: "fail" });
  }
});

module.exports = router;
