const ENV = require("../config/env");

async function getCatalogText() {
  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";
  const url = `${base}/api/partner/v1/catalog`;
  
  if (!ENV.CARDAPIOWEB_TOKEN) return "Cardápio indisponível no momento.";

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-API-KEY": ENV.CARDAPIOWEB_TOKEN,
        "Accept": "application/json",
      },
    });

    const data = await resp.json();

    if (!resp.ok || !data?.categories?.length) {
      return "O cardápio está sendo atualizado 😄";
    }

    let menuText = "📋 *CARDÁPIO PAPPI PIZZA:*\n";
    for (const cat of data.categories) {
      if (cat?.status !== "ACTIVE") continue;
      menuText += `\n🍕 *${cat.name.toUpperCase()}*\n`;
      for (const item of cat.items || []) {
        if (item?.status !== "ACTIVE") continue;
        menuText += `- ${item.name}: R$ ${Number(item.price).toFixed(2)}\n`;
      }
    }
    return menuText.trim();
  } catch (e) {
    return "Erro ao carregar o cardápio.";
  }
}

module.exports = { getCatalogText };
