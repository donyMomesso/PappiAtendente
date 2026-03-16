const ENV = require("../config/env");

async function createPrefilledOrder(orderData) {
    // URL para criar o pedido pré-preenchido
    const url = `https://integracao.cardapioweb.com/api/partner/v1/merchant/prefilled_order`;
    
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "X-API-KEY": ENV.CARDAPIOWEB_TOKEN,
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(orderData)
        });

        if (response.ok) {
            return await response.json();
        }
        
        const error = await response.json();
        return { ok: false, error: error.message };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function changeOrderStatus(orderId, action) {
    const url = `https://integracao.cardapioweb.com/api/partner/v1/orders/${orderId}/${action}`;
    const apiKey = ENV.CARDAPIOWEB_API_KEY || ENV.CARDAPIOWEB_TOKEN;
    const partnerKey = ENV.CARDAPIOWEB_PARTNER_KEY;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "X-API-KEY": apiKey,
                "X-PARTNER-KEY": partnerKey,
                "Accept": "application/json"
            }
        });
        if (response.status === 204) return { ok: true };
        const data = await response.json().catch(() => null);
        return { ok: false, error: data?.message || `HTTP ${response.status}` };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { createPrefilledOrder, changeOrderStatus };
