const ENV = require("../config/env");

async function downloadWhatsAppMedia(mediaId) {
    try {
        // 1. Pega a URL do arquivo no WhatsApp
        const urlResponse = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
            headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}` }
        });
        const { url } = await urlResponse.json();

        // 2. Faz o download do áudio (buffer)
        const mediaResponse = await fetch(url, {
            headers: { "Authorization": `Bearer ${ENV.WHATSAPP_TOKEN}` }
        });
        
        const buffer = await mediaResponse.arrayBuffer();
        return Buffer.from(buffer).toString("base64"); // Converte para Base64 para a IA
    } catch (e) {
        console.error("🔥 Erro ao baixar áudio:", e);
        return null;
    }
}

module.exports = { downloadWhatsAppMedia };
