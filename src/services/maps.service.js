// src/services/maps.service.js
const ENV = require("../config/env");

// Node 18+ tem fetch
const fetchImpl = global.fetch || require("node-fetch");

function round(n, d = 3) {
  const p = Math.pow(10, d);
  return Math.round(Number(n) * p) / p;
}

// haversine distance in km
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function quoteByAddress(addressText) {
  if (!ENV.GOOGLE_MAPS_API_KEY) return null;
  if (!addressText) return null;

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(addressText)}` +
    `&key=${ENV.GOOGLE_MAPS_API_KEY}` +
    "&region=br&language=pt-BR";

  const geoResp = await fetchImpl(url).catch(() => null);
  if (!geoResp) return null;

  const geo = await geoResp.json().catch(() => null);
  const r = geo?.results?.[0];
  if (!r) return null;

  const destLat = r?.geometry?.location?.lat;
  const destLng = r?.geometry?.location?.lng;

  const lat = Number(destLat);
  const lng = Number(destLng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const km = distanceKm(Number(ENV.STORE_LAT), Number(ENV.STORE_LNG), lat, lng);
  const etaMinutes = Math.max(20, Math.round(km * 4 + 20)); // heurística simples
  const deliveryFee = Math.max(0, Math.round(km * 2)); // heurística simples

  return {
    formatted_address: r.formatted_address,
    latitude: round(lat, 6),
    longitude: round(lng, 6),
    km: round(km, 1),
    eta_minutes: etaMinutes,
    delivery_fee: deliveryFee,
    is_serviceable: true,
  };
}

module.exports = { quoteByAddress, distanceKm };
