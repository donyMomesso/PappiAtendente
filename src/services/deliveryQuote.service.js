// src/services/deliveryQuote.service.js
const ENV = require("../config/env");
const maps = require("./maps.service");

const MAX_KM = Number(process.env.DELIVERY_MAX_KM || 12);

function hasEnoughAddress(text) {
  const t = String(text || "").toLowerCase().trim();
  if (t.length < 6) return false;
  const hasNumber = /\b\d{1,5}\b/.test(t);
  return hasNumber;
}

async function quoteDeliveryIfPossible(addressText) {
  if (!ENV.GOOGLE_MAPS_API_KEY) return { ok: false, reason: "NO_KEY" };
  if (!hasEnoughAddress(addressText)) return { ok: false, reason: "INCOMPLETE_ADDRESS" };

  try {
    const q = await maps.quoteByAddress(addressText);
    const km = Number(q?.km);

    if (!Number.isFinite(km)) return { ok: false, reason: "NO_KM" };

    const within = q?.is_serviceable === true && km <= MAX_KM;

    return {
      ok: true,
      within,
      km,
      etaMin: q?.eta_minutes ?? null,
      fee: q?.delivery_fee ?? null,
      formatted: q?.formatted_address || addressText,
      lat: Number.isFinite(Number(q?.latitude)) ? Number(q.latitude) : null,
      lng: Number.isFinite(Number(q?.longitude)) ? Number(q.longitude) : null,
      service_limit_km_hint: MAX_KM,
    };
  } catch (e) {
    console.error("Erro no cálculo de entrega:", e?.message || e);
    return { ok: false, reason: "QUOTE_FAILED" };
  }
}

module.exports = { quoteDeliveryIfPossible, MAX_KM };
