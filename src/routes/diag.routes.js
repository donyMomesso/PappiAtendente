// src/routes/diag.routes.js
// Rota de diagnóstico — valida credenciais e conectividade com CardápioWeb
const express = require("express");
const ENV = require("../config/env");
const { getPaymentMethods, getCatalogRaw } = require("../services/cardapioWeb.service");

const router = express.Router();

router.get("/diag/cardapioweb", async (req, res) => {
  const result = {
    env: {
      CARDAPIOWEB_BASE_URL: ENV.CARDAPIOWEB_BASE_URL || "(não definido)",
      CARDAPIOWEB_API_KEY: ENV.CARDAPIOWEB_API_KEY ? `${ENV.CARDAPIOWEB_API_KEY.slice(0, 6)}…` : "(não definido ❌)",
      CARDAPIOWEB_PARTNER_KEY: ENV.CARDAPIOWEB_PARTNER_KEY ? `${ENV.CARDAPIOWEB_PARTNER_KEY.slice(0, 8)}…` : "(não definido ❌)",
    },
    payment_methods: null,
    catalog_items: null,
    errors: [],
  };

  // Testa métodos de pagamento
  try {
    const methods = await getPaymentMethods();
    result.payment_methods = methods.length > 0
      ? methods.map(m => ({ id: m.id, name: m.name, kind: m.kind }))
      : "(lista vazia — verifique se a loja tem métodos ativos)";
  } catch (e) {
    result.errors.push(`payment_methods: ${e.message}`);
  }

  // Testa catálogo
  try {
    const catalog = await getCatalogRaw();
    const items = Array.isArray(catalog)
      ? catalog
      : (catalog?.items || catalog?.products || catalog?.data || []);
    result.catalog_items = Array.isArray(items)
      ? `${items.length} item(s) encontrado(s)`
      : "resposta recebida (estrutura diferente do esperado)";
  } catch (e) {
    result.errors.push(`catalog: ${e.message}`);
  }

  const ok = result.errors.length === 0;
  res.status(ok ? 200 : 502).json({ ok, ...result });
});

module.exports = router;
