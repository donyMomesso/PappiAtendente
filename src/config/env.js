// src/config/env.js
require("dotenv").config();

const WEBHOOK_VERIFY_TOKEN =
  process.env.WEBHOOK_VERIFY_TOKEN ||
  process.env.WEBHOOK_TOKEN ||
  "";

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  // Webhook
  WEBHOOK_VERIFY_TOKEN,

  // WhatsApp Cloud API (Meta)
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || "",
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID || "",

  // Segurança interna
  ATTENDANT_API_KEY: process.env.ATTENDANT_API_KEY || "",

  // CardápioWeb (⚠️ existem fluxos diferentes: catálogo x pedidos)
  CARDAPIOWEB_BASE_URL:
    process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com",

  // Pode ser exigido por alguns catálogos
  CARDAPIOWEB_STORE_ID: process.env.CARDAPIOWEB_STORE_ID || "",

  // Chave da loja (X-API-KEY) — compat com legado CARDAPIOWEB_TOKEN
  CARDAPIOWEB_API_KEY:
    process.env.CARDAPIOWEB_API_KEY || process.env.CARDAPIOWEB_TOKEN || "",

  // Chave do integrador (X-PARTNER-KEY) — usada nos endpoints Partner (PDV/pedido)
  CARDAPIOWEB_PARTNER_KEY: process.env.CARDAPIOWEB_PARTNER_KEY || "",

  // (legado) mantenha para não quebrar imports antigos
  CARDAPIOWEB_TOKEN: process.env.CARDAPIOWEB_TOKEN || "",

  // Google Maps
  GOOGLE_MAPS_API_KEY:
    process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || "",

  // Gemini
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: (process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, ""),

  // Loja (coordenadas, opcional)
  STORE_LAT: toNumber(process.env.STORE_LAT, null),
  STORE_LNG: toNumber(process.env.STORE_LNG, null),

  // Banco Inter
  INTER_CERT_PATH: process.env.INTER_CERT_PATH || "",
  INTER_KEY_PATH: process.env.INTER_KEY_PATH || "",
  INTER_CA_PATH: process.env.INTER_CA_PATH || "",
  INTER_CLIENT_ID: process.env.INTER_CLIENT_ID || "",
  INTER_CLIENT_SECRET: process.env.INTER_CLIENT_SECRET || "",
  INTER_CHAVE_PIX: process.env.INTER_CHAVE_PIX || "",
  INTER_CONTA_CORRENTE: process.env.INTER_CONTA_CORRENTE || "",
};
