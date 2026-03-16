const ENV = require("../config/env");

function baseUrl() {
  return (ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com").replace(/\/+$/, "");
}

function apiKey({ write = false } = {}) {
  const k = write ? (ENV.CARDAPIOWEB_TOKEN_WRITE || ENV.CARDAPIOWEB_TOKEN) : (ENV.CARDAPIOWEB_TOKEN_READ || ENV.CARDAPIOWEB_TOKEN);
  return String(k || "").trim();
}

async function requestJson(path, { method = "GET", query, body, write = false } = {}) {
  const key = apiKey({ write });
  if (!key) throw new Error(write ? "CARDAPIOWEB_TOKEN_WRITE não configurado" : "CARDAPIOWEB_TOKEN_READ não configurado");

  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const url = `${baseUrl()}${path}${qs}`;

  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-KEY": key,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }

  if (!resp.ok) {
    console.error("🔥 CardapioWeb ERROR", { url, status: resp.status, body: data || text });
    const msg = (data && (data.message || data.error)) ? (data.message || data.error) : `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

module.exports = { requestJson };
