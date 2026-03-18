// @ts-nocheck
// src/routes/public.routes.js
const express = require("express");
const ENV = require("../config/env");
const { PrismaClient } = require("@prisma/client");

const fetch = global.fetch || require("node-fetch");

const { loadRulesFromFiles } = require("../rules/loader");
const { getMode } = require("../services/context.service");
const { getUpsellHint, TOP_PIZZAS, COMBOS_SALGADAS, COMBOS_DOCES } = require("../services/upsell.service");
const { quoteDeliveryIfPossible, MAX_KM } = require("../services/deliveryQuote.service");
const { createPixCharge } = require("../services/interPix.service");

// Cardápio Web (CORRETO: dupla autenticação)
const { createOrder, cancelOrder, getPaymentMethods, getCwCustomerByPhone, getCwOrderById, getMerchant } = require("../services/cardapioWeb.service");

const router = express.Router();
const prisma = new PrismaClient();

const LINK_CARDAPIO = "https://pappipizza.cardapioweb.com";

// ===================================================
// Config de mensagens / SLA
// ===================================================
const ETA_DELIVERY = "40 a 60 min";
const ETA_TAKEOUT = "30 a 40 min";

// ===================================================
// Horário de funcionamento (cache 2 min)
// ===================================================
let merchantCache = { open: null, hoursText: null, checkedAt: 0 };

const DAY_KEYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

async function isStoreOpen() {
  const now = Date.now();
  if (merchantCache.open !== null && now - merchantCache.checkedAt < 2 * 60 * 1000) {
    return merchantCache.open;
  }
  try {
    const merchant = await getMerchant();

    // Loja inativa no CW (INACTIVE, BLOCKED, etc.) — só ACTIVE está operacional
    if (merchant?.status && merchant.status !== "ACTIVE") {
      merchantCache = { open: false, hoursText: null, checkedAt: now };
      return false;
    }

    const oh = merchant?.opening_hours;
    let open = true;
    let hoursText = null;

    if (oh) {
      // temporary_state "closed" só vale se o prazo ainda não expirou
      const tmpEnd = oh.temporary_state_end_at ? new Date(oh.temporary_state_end_at) : null;
      if (oh.temporary_state === "closed" && tmpEnd && tmpEnd > new Date()) {
        merchantCache = { open: false, hoursText: null, checkedAt: now };
        return false;
      }

      // Verifica o horário de hoje (fuso São Paulo)
      const spNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
      const dayKey = DAY_KEYS[spNow.getDay()];
      const intervals = oh[dayKey]; // ex: [["18:00","22:00"]]

      if (Array.isArray(intervals) && intervals.length > 0) {
        const hhmm = n => { const [h,m] = String(n).split(":"); return Number(h)*60+Number(m); };
        const cur = spNow.getHours()*60 + spNow.getMinutes();
        open = intervals.some(([s, e]) => cur >= hhmm(s) && cur < hhmm(e));
        // Texto amigável: primeiro intervalo do dia
        const [s, e] = intervals[0];
        hoursText = `${s} às ${e}`;
      }
    }

    merchantCache = { open, hoursText, checkedAt: now };
    return open;
  } catch {
    return true; // em caso de erro, não bloqueia
  }
}

// ===================================================
// Anti-duplicação (WhatsApp pode reenviar)
// ===================================================
const processedMsgIds = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedMsgIds.has(id)) return true;
  processedMsgIds.add(id);
  if (processedMsgIds.size > 5000) processedMsgIds.clear();
  return false;
}

// ===================================================
// Memória curta por telefone (últimas 12 falas)
// ===================================================
const chatHistory = new Map();
function pushHistory(phone, role, text) {
  if (!chatHistory.has(phone)) chatHistory.set(phone, []);
  const h = chatHistory.get(phone);
  h.push({ role, text: String(text || "").slice(0, 900) });
  if (h.length > 12) h.splice(0, h.length - 12);
}
function getHistoryText(phone) {
  const h = chatHistory.get(phone) || [];
  return h.map((x) => (x.role === "user" ? `Cliente: ${x.text}` : `Atendente: ${x.text}`)).join("\n");
}
function detectLoop(phone) {
  const h = chatHistory.get(phone) || [];
  const last2 = h.slice(-2).filter((x) => x.role === "assistant").map((x) => x.text);
  if (last2.length < 2) return false;
  return last2[0] === last2[1];
}

// ===================================================
// DISC (detecção leve + tom humano)
// ===================================================
function detectDISC(historyText, userText) {
  const t = `${historyText}\n${userText}`.toLowerCase();
  const score = { D: 0, I: 0, S: 0, C: 0 };

  if (/(rápido|agora|urgente|pra ontem|resolve|quero logo|sem enrolar|objetivo|direto)/i.test(t)) score.D += 3;
  if (/(quanto fica|valor|taxa|preço|total|fechou|manda)/i.test(t)) score.D += 2;

  if (/(kkk|haha|top|show|amei|perfeito|manda aí|bora|😍|😂|🔥|👏)/i.test(t)) score.I += 3;
  if (/(promo|novidade|qual recomenda|surpreende|capricha)/i.test(t)) score.I += 2;

  if (/(tranquilo|de boa|sem pressa|tanto faz|pode ser|confio|obrigado|valeu)/i.test(t)) score.S += 3;
  if (/(família|criança|pra todo mundo|clássica)/i.test(t)) score.S += 1;

  if (/(detalhe|certinho|confirma|comprovante|conforme|tamanho|ingrediente|sem|com|meio a meio|observação)/i.test(t)) score.C += 3;
  if (/(cep|número|bairro|endereço|nota|troco|cartão|pix)/i.test(t)) score.C += 2;

  let best = "S";
  let bestVal = -1;
  for (const k of ["D", "I", "S", "C"]) {
    if (score[k] > bestVal) { bestVal = score[k]; best = k; }
  }
  return best;
}

function discToneGuidance(disc) {
  switch (disc) {
    case "D": return `Tom: direto e rápido. Frases curtas. 1 pergunta por vez. Máx 1 emoji.`;
    case "I": return `Tom: animado e caloroso. Pode usar 1–2 emojis. Sugira 1 recomendação.`;
    case "C": return `Tom: claro e organizado. Confirme detalhes (tamanho, sabores, endereço). Sem textão.`;
    case "S": default: return `Tom: acolhedor e tranquilo. Passe segurança. 1 pergunta por vez.`;
  }
}

// ===================================================
// HANDOFF (modo humano)
// ===================================================
const handoffMemory = new Map();

function isHandoffOn(phone, customer) {
  if (customer && customer.handoff === true) return true;
  const mem = handoffMemory.get(phone);
  return mem?.on === true;
}

async function setHandoffOn(phone) {
  handoffMemory.set(phone, { on: true, at: Date.now() });
  await prisma.customer.update({
    where: { phone }, data: { handoff: true, handoffAt: new Date(), lastInteraction: new Date() },
  }).catch(() => null);
}

async function clearHandoff(phone) {
  handoffMemory.delete(phone);
  await prisma.customer.update({
    where: { phone }, data: { handoff: false, lastInteraction: new Date() },
  }).catch(() => null);
}

// ===================================================
// Desescalation (irritação / pedir atendente)
// ===================================================
function detectHumanRequest(text) {
  const t = String(text || "").toLowerCase();
  return /(humano|atendente|pessoa|moça|moca|falar com|me atende|quero atendimento|chama alguém|gerente)/i.test(t);
}
function detectIrritation(text) {
  const t = String(text || "").toLowerCase();
  return /(caracas|aff|pqp|irritad|raiva|rid[ií]culo|absurdo|lixo|merda|porra|n[aã]o aguento|ta errado|de novo|para|chega|vsf)/i.test(t);
}

async function askDeescalationButtons(to) {
  return sendButtons(to, "Entendi 🙏 Vamos resolver agora. Como prefere?", [
    { id: "HELP_HUMAN", title: "👩‍💼 Atendente" },
    { id: "HELP_BOT", title: "✅ Continuar" },
    { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
  ]);
}

// ===================================================
// Draft do pedido
// ===================================================
const askedName = new Set();
const orderDraft = new Map();
const pendingNewOrder = new Map(); // payload aguardando decisão de acrescentar vs novo pedido
const feeCache = new Map(); // address → { fee, lat, lng, formatted, ts } — evita chamar Maps+CW a cada mensagem

function getDraft(phone) { return orderDraft.get(phone) || null; }
function setDraft(phone, text) { orderDraft.set(phone, { text: String(text || "").slice(0, 700), updatedAt: Date.now() }); }
function clearDraft(phone) { orderDraft.delete(phone); }

// ===================================================
// MEMÓRIA DE PREFERÊNCIAS
// ===================================================
function detectNewPreferences(text, existingPrefs) {
  const t = String(text || "").toLowerCase();
  const found = [];
  if (/sem cebola/i.test(t)) found.push("sem cebola");
  if (/sem azeitona/i.test(t)) found.push("sem azeitona");
  if (/sem pimenta/i.test(t)) found.push("sem pimenta");
  if (/borda (recheada|cheddar|catupiry|cream cheese)/i.test(t)) {
    const m = t.match(/borda ([a-zà-ú ]+)/i);
    if (m) found.push(`borda ${m[1].trim()}`);
  }
  if (/bem assad[ao]/i.test(t)) found.push("bem assada");
  if (/massa fina/i.test(t)) found.push("massa fina");
  if (/massa grossa/i.test(t)) found.push("massa grossa");
  if (!found.length) return null;
  const existing = existingPrefs.toLowerCase();
  const newOnes = found.filter(p => !existing.includes(p));
  return newOnes.length ? newOnes.join(", ") : null;
}

function mergePreferences(existing, newPrefs) {
  if (!existing) return newPrefs;
  return `${existing}, ${newPrefs}`.slice(0, 300);
}

function buildOrderSummary(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items.map(i => {
    const opts = (i.options || []).map(o => o.name).filter(Boolean).join("+");
    return `${i.name}${opts ? ` (${opts})` : ""}`;
  }).join(", ").slice(0, 200);
}

function formatPhoneBR(phone) {
  const d = String(phone || "").replace(/\D/g, "").replace(/^55/, "");
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return phone;
}

function buildOrderReceipt({ payload, customer, displayId, cwDisplayId, payList }) {
  const now = new Date();
  const datePart = now.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
  const timePart = now.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const isDelivery = payload.order_type === "delivery";

  // Cabeçalho
  let txt = `#️⃣  *Pedido Nº ${cwDisplayId || displayId}*\n`;
  txt += `feito em ${datePart} ${timePart}\n\n`;

  // Cliente
  txt += `👤  *${customer.name || "Cliente"}*\n`;
  txt += `📞  ${formatPhoneBR(customer.phone)}\n\n`;

  // Endereço
  if (isDelivery && payload.delivery_address) {
    const addr = payload.delivery_address;
    txt += `🛵  *Endereço de entrega*\n`;
    const street = [addr.street_name, addr.street_number].filter(Boolean).join(", ");
    if (street) txt += `${street}\n`;
    if (addr.complement) txt += `Complemento: ${addr.complement}\n`;
    if (addr.reference) txt += `Referência: ${addr.reference}\n`;
    const cityParts = [addr.neighborhood, addr.city ? `${addr.city}/SP` : null].filter(Boolean).join(", ");
    if (cityParts) txt += `${cityParts}\n`;
    txt += "\n";
  }

  // Itens
  txt += `------ ITENS DO PEDIDO ------\n\n`;
  for (const item of (payload.items || [])) {
    txt += `*${item.quantity} x ${item.name}*\n`;
    const optNames = (item.options || []).map(o => o.name).filter(Boolean);
    if (optNames.length > 0) txt += `➡️ ${optNames.join(", ")}\n`;
    if (item.observation) txt += `❗ OBS: ${item.observation}\n`;
    const priceStr = `R$ ${Number(item.unit_price).toFixed(2).replace(".", ",")}`;
    const totalStr = `R$ ${Number(item.total_price).toFixed(2).replace(".", ",")}`;
    txt += `💵 ${item.quantity} x ${priceStr} = ${totalStr}\n\n`;
  }
  txt += `-----------------------------\n\n`;

  // Totais
  const subtotal = (payload.totals?.order_amount || 0) - (payload.totals?.delivery_fee || 0);
  txt += `SUBTOTAL: R$ ${Number(subtotal).toFixed(2).replace(".", ",")}\n`;
  if (isDelivery) txt += `ENTREGA: R$ ${Number(payload.totals?.delivery_fee || 0).toFixed(2).replace(".", ",")}\n`;
  if (payload.totals?.discounts > 0) txt += `DESCONTO: -R$ ${Number(payload.totals.discounts).toFixed(2).replace(".", ",")}\n`;
  txt += `\n*VALOR FINAL: R$ ${Number(payload.totals?.order_amount || 0).toFixed(2).replace(".", ",")}*\n`;

  // Pagamento
  const pmId = payload.payments?.[0]?.payment_method_id;
  const pmName = Array.isArray(payList) && pmId
    ? (payList.find(p => p.id === pmId)?.name || null)
    : null;
  const pmLabel = pmName || (customer.preferredPayment === "pix" ? "PIX" : customer.preferredPayment === "cartao" ? "Cartão" : "Dinheiro");
  const pmTotal = `R$ ${Number(payload.payments?.[0]?.total || payload.totals?.order_amount || 0).toFixed(2).replace(".", ",")}`;
  txt += `\n💲  *FORMA DE PAGAMENTO*\n${pmLabel}: ${pmTotal}\n`;

  return txt;
}

function looksLikeOrderIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (/(quero|pedir|fecha|fechar|vou querer|manda|me vê)/i.test(t)) return true;
  if (/(pizza|calabresa|mussarela|frango|portuguesa|4 queijos|quatro queijos|meia|metade|borda|grande|m[eé]dia|pequena|gigante|16)/i.test(t)) return true;
  if (/(quanto|valor|preço|preco|taxa)/i.test(t) && t.length < 30) return false;
  return false;
}

// ===================================================
// Helpers texto / endereço
// ===================================================
function digitsOnly(str) { return String(str || "").replace(/\D/g, ""); }
// WhatsApp envia "5511987654321" (13 dígitos). CardápioWeb exige exatamente 11.
function toLocalPhone(str) {
  const d = digitsOnly(str);
  if (d.length === 13 && d.startsWith("55")) return d.slice(2); // remove +55
  if (d.length === 12 && d.startsWith("55")) return d.slice(2);
  return d;
}
function extractCep(text) {
  const t = String(text || "").trim();
  // usuário digitou só o CEP (8 dígitos)
  if (/^\d{8}$/.test(t)) return t;
  // CEP com traço: 13051-135
  const m = t.match(/\b(\d{5})-(\d{3})\b/);
  if (m) return m[1] + m[2];
  // 8 dígitos seguidos dentro de um texto
  const m2 = t.match(/\b(\d{8})\b/);
  if (m2) return m2[1];
  return null;
}
function extractHouseNumber(text) { const m = String(text || "").match(/\b\d{1,5}\b/); return m ? m[0] : null; }
function looksLikeNoComplement(text) {
  const t = String(text || "").trim().toLowerCase();
  // "nao", "não", "sem", "nenhum" — com ou sem o que vem depois (ex: "nao 53")
  return /^(n[aã]o|sem|nenhum)(\s|$)/.test(t) || /^(n[aã]o tem|n[aã]o precisa)\s*(complemento)?$/i.test(t);
}
function detectCancelRequest(text) {
  return /\b(cancel(ar?|a|ei)|desist(ir|o)|n[aã]o (quero|vou) (mais|o pedido)|desejo cancelar)\b/i.test(String(text || ""));
}

function looksLikeAddress(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (extractCep(t)) return true;
  const hasStreetWord = /(rua|r\.|avenida|av\.|travessa|tv\.|alameda|rodovia|estrada|praça|praca|bairro|n[ºo]\b|n\.)/i.test(t);
  const hasNumber = /\b\d{1,5}\b/.test(t);
  const isIntentPhrase = /(pizza|quanto|preço|preco|valor|card[aá]pio|menu|promo|rápido|rapido)/i.test(t);
  if (isIntentPhrase && !hasStreetWord) return false;
  return (hasStreetWord && hasNumber) || (hasStreetWord && t.length >= 10);
}

// ===================================================
// EXTRAÇÃO LEVE (nome / entrega / pagamento)
// ===================================================
function extractNameLight(text) {
  const t = String(text || "").trim();
  if (/^[A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2}$/.test(t) && t.length >= 2) {
    if (/^(sim|nao|não|ok|blz|beleza|oi|ola|olá)$/i.test(t)) return null;
    return t.slice(0, 60);
  }
  const m = t.match(/(?:meu nome é|aqui é o|aqui é a|sou o|sou a|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i);
  const name = m?.[1]?.trim();
  if (!name || name.length < 2) return null;
  return name.slice(0, 60);
}

function looksLikeGarbageName(name) {
  const n = String(name || "").trim();
  if (n.length < 2) return true;
  const vowels = (n.match(/[aeiouáàâãéèêíìîóòôõúùûy]/gi) || []).length;
  if (vowels < 1) return true;
  if (/(.)\1\1/.test(n)) return true;
  return false;
}

function detectFulfillmentLight(text) {
  const t = String(text || "").toLowerCase();
  if (/retirada|retirar|balc[aã]o|vou buscar/i.test(t)) return "retirada";
  if (/entrega|delivery|entregar/i.test(t)) return "entrega";
  return null;
}

function detectPaymentLight(text) {
  const t = String(text || "").toLowerCase();
  if (/pix/i.test(t)) return "pix";
  if (/cart[aã]o|credito|crédito|d[eé]bito/i.test(t)) return "cartao";
  if (/dinheiro|troco/i.test(t)) return "dinheiro";
  return null;
}

function shouldAskName(phone, customer) {
  if (customer?.name) return false;
  if (askedName.has(phone)) return false;
  askedName.add(phone);
  return true;
}

// ===================================================
// WhatsApp Cloud API helpers
// ===================================================
async function waSend(payload) {
  if (!ENV.WHATSAPP_TOKEN || !ENV.WHATSAPP_PHONE_NUMBER_ID) return;
  const url = `https://graph.facebook.com/v24.0/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((e) => console.error("❌ Erro WA API:", e));
}

async function sendText(to, text) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "text",
    text: { body: String(text || "").slice(0, 3500) }
  });
}

async function sendImage(to, imageUrl, caption) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "image",
    image: { link: imageUrl, caption: caption ? String(caption).slice(0, 1000) : undefined }
  });
}

async function sendButtons(to, bodyText, buttons) {
  return waSend({
    messaging_product: "whatsapp",
    to: digitsOnly(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: String(b.id), title: String(b.title).slice(0, 20) }
        }))
      }
    },
  });
}

async function askFulfillmentButtons(to) {
  return sendButtons(to, "Pra agilizar 😊 é *Entrega* ou *Retirada*?", [
    { id: "FULFILLMENT_ENTREGA", title: "🚚 Entrega" },
    { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
  ]);
}

async function askPaymentButtons(to) {
  return sendButtons(to, "E o pagamento vai ser como? 💳", [
    { id: "PAY_PIX", title: "⚡ PIX" },
    { id: "PAY_CARTAO", title: "💳 Cartão" },
    { id: "PAY_DINHEIRO", title: "💵 Dinheiro" },
  ]);
}

async function askDuplicateOrderButtons(to, existingDisplayId) {
  return sendButtons(
    to,
    `Você já tem um pedido em andamento (*#${existingDisplayId}*). O que prefere?`,
    [
      { id: "ORDER_ADD", title: "Acrescentar ao pedido" },
      { id: "ORDER_NEW", title: "Novo pedido separado" },
    ]
  );
}

// ===================================================
// Rapport / início de conversa (1x por telefone)
// ===================================================
const greeted = new Set();
function isGreetingText(t) {
  const s = String(t || "").trim().toLowerCase();
  return /^(oi|ol[aá]|bom dia|boa tarde|boa noite|menu|card[aá]pio|e a[ií]|eai|opa|ol[aá] tudo|tudo bem)$/i.test(s);
}

async function sendRapport(to, customer) {
  const name = customer?.name;
  const visits = customer?.visitCount || 0;
  const lastOrder = customer?.lastOrderSummary;
  const hasPrefs = customer?.lastFulfillment && customer?.preferredPayment;

  // Busca pontos de fidelidade no CW (sem bloquear o fluxo se falhar)
  const cwCustomer = await getCwCustomerByPhone(to).catch(() => null);
  const points = cwCustomer?.loyalty_points || 0;
  const pointsHint = points > 0 ? `\n🎁 Você tem *${points} pontos* de fidelidade acumulados!` : "";

  const fulfillmentBtns = [
    { id: "FULFILLMENT_ENTREGA", title: "🚚 Entrega" },
    { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
  ];

  if (visits === 0) {
    await sendButtons(to,
      `Olá${name ? `, ${name}` : ""}! 👋 Bem-vindo(a) à *Pappi Pizza* 🍕\n\n` +
      `Cardápio online: ${LINK_CARDAPIO}\n` +
      `⏱️ Entrega ${ETA_DELIVERY} | Retirada ${ETA_TAKEOUT}\n\n` +
      `É *Entrega* ou *Retirada*?`,
      fulfillmentBtns
    );

  } else if (visits < 5) {
    // REGULAR: reconhece preferência de fulfillment se tiver
    const lastF = customer?.lastFulfillment;
    let txt;
    if (lastF === "retirada") {
      txt = `Oi, ${name || "pessoal"}! 😄 Vem buscar aqui de novo hoje?${pointsHint}`;
    } else if (lastF === "entrega") {
      txt = `Oi, ${name || "pessoal"}! 😄 Delivery de novo ou hoje você mesmo vem buscar?${pointsHint}`;
    } else {
      const hint = lastOrder ? ` Última vez foi *${lastOrder.split(",")[0]}* 😋` : "";
      txt = `Oi, ${name || "pessoal"}! 😊 Que bom te ver!${hint}${pointsHint}\n\nHoje é *Entrega* ou *Retirada*?`;
    }
    // Coloca o botão da preferência primeiro
    const orderedBtns = lastF === "retirada"
      ? [{ id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" }, { id: "FULFILLMENT_ENTREGA", title: "🚚 Entrega" }]
      : lastF === "entrega"
        ? [{ id: "FULFILLMENT_ENTREGA", title: "🚚 Entrega" }, { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" }]
        : fulfillmentBtns;
    await sendButtons(to, txt, orderedBtns);

  } else {
    // VIP/EXPERT: casual, direto, sugere o pedido de sempre
    const pizza = lastOrder ? lastOrder.split(",")[0].trim() : null;
    if (pizza && hasPrefs) {
      // Tem tudo salvo — oferece direto a pizza com botão de repetir
      await sendButtons(to,
        `Ei, ${name}! 🍕🔥 Bem-vindo de volta!${pointsHint}\n\nVai de *${pizza}* de sempre, ou hoje tem novidade?`,
        [
          { id: "REPEAT_LAST_ORDER", title: "✅ Mesma de sempre" },
          { id: "FULFILLMENT_ENTREGA", title: "🚚 Entrega" },
          { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
        ]
      );
    } else {
      const lastF = customer?.lastFulfillment;
      const txt = lastF === "retirada"
        ? `Ei, ${name || "você"}! 🔥 De volta na Pappi!${pointsHint} Buscando aqui de novo?`
        : lastF === "entrega"
          ? `Ei, ${name || "você"}! 🔥 De volta na Pappi!${pointsHint} Entrega de novo?`
          : `Ei, ${name || "você"}! 🔥 De volta na Pappi!${pointsHint} Entrega ou retirada hoje?`;
      await sendButtons(to, txt, fulfillmentBtns);
    }
  }
}

// ===================================================
// Address Flow (GUIADO + CEP + GPS)
// ===================================================
const addressFlow = new Map();

function getAF(phone) {
  if (!addressFlow.has(phone)) addressFlow.set(phone, { step: null });
  return addressFlow.get(phone);
}
function resetAF(phone) { addressFlow.set(phone, { step: null }); }

function buildAddressText(af) {
  const parts = [];
  if (af.street) parts.push(af.street);
  if (af.number) parts.push(af.number);
  if (af.bairro) parts.push(af.bairro);
  if (af.cep) parts.push(`CEP ${af.cep}`);
  if (af.complemento) parts.push(af.complemento);
  return `${parts.join(" - ")}, Campinas - SP`;
}

async function safeQuote(addressText) {
  try { return await quoteDeliveryIfPossible(addressText); }
  catch (e1) {
    try { return await quoteDeliveryIfPossible({ addressText }); }
    catch (e2) { return null; }
  }
}

async function reverseGeocodeLatLng(lat, lng) {
  if (!ENV.GOOGLE_MAPS_API_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${ENV.GOOGLE_MAPS_API_KEY}&language=pt-BR&result_type=street_address|premise|subpremise|route`;
  const resp = await fetch(url).catch(() => null);
  if (!resp) return null;
  const data = await resp.json().catch(() => null);
  return data?.results?.[0]?.formatted_address || null;
}

async function askAddressConfirm(to, formatted, delivery) {
  const feeTxt = delivery?.fee != null ? `R$ ${Number(delivery.fee).toFixed(2)}` : "a confirmar";
  const kmTxt = Number.isFinite(delivery?.km) ? `${delivery.km.toFixed(1)} km` : "";
  const txt = `Confere o endereço? 📍\n*${formatted}*\nTaxa: *${feeTxt}*${kmTxt ? ` | ${kmTxt}` : ""}`;
  return sendButtons(to, txt, [
    { id: "ADDR_CONFIRM", title: "✅ Confirmar" },
    { id: "ADDR_CORRECT", title: "✏️ Corrigir" },
  ]);
}

// ===================================================
// IA (Gemini) - RÁPIDA E EFICIENTE
// ===================================================
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
let cachedGeminiModel = null;
let geminiDisabledUntil = 0;

function isGeminiDisabled() { return Date.now() < geminiDisabledUntil; }
function disableGeminiFor(ms) { geminiDisabledUntil = Date.now() + ms; }

async function listGeminiModels() {
  const apiKey = ENV.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada.");
  const resp = await fetch(`${GEMINI_API_BASE}/models`, { headers: { "x-goog-api-key": apiKey } });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.models || [];
}

function pickGeminiModel(models) {
  const supported = models.filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));
  const preferred = [(ENV.GEMINI_MODEL || "").replace(/^models\//, ""), "gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"].filter(Boolean);
  for (const name of preferred) {
    const full = name.startsWith("models/") ? name : `models/${name}`;
    const found = supported.find((m) => m.name === full);
    if (found) return found.name;
  }
  return supported[0]?.name || null;
}

async function ensureGeminiModel(forceRefresh = false) {
  if (cachedGeminiModel && !forceRefresh) return cachedGeminiModel;
  const models = await listGeminiModels();
  const picked = pickGeminiModel(models);
  if (!picked) throw new Error("Nenhum modelo com generateContent disponível.");
  cachedGeminiModel = picked;
  return cachedGeminiModel;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function geminiGenerate(content) {
  if (isGeminiDisabled()) {
    const e = new Error("gemini_disabled_temporarily"); e.code = "GEMINI_DISABLED"; throw e;
  }
  const apiKey = ENV.GEMINI_API_KEY || "";
  let model = await ensureGeminiModel(false);
  const body = Array.isArray(content)
    ? { contents: [{ parts: content }] }
    : { contents: [{ parts: [{ text: String(content || "") }] }] };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";

    if (resp.status === 429) {
      console.error("❌ Gemini falhou (429): Rate Limit Esgotado.");
      const retryDelaySec = Number(String(data?.error?.details?.find?.((d) => d?.retryDelay)?.retryDelay || "").replace("s", "")) || 10;
      if (attempt === 1 && retryDelaySec <= 4) {
        await ensureGeminiModel(true); model = cachedGeminiModel; await sleep(retryDelaySec * 1000); continue;
      }
      disableGeminiFor(2 * 60 * 1000);
      const e = new Error("gemini_quota_exceeded"); e.code = 429; throw e;
    }
    const e = new Error(`generateContent failed: ${resp.status}`); e.code = resp.status; throw e;
  }
  return "";
}

  // ===================================================
// CACHE DO CARDAPIOWEB (CATÁLOGO)
// ===================================================
let menuCache = { data: null, raw: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;

// ✅ AJUSTE: prioriza TOKEN (Render) e usa API_KEY como fallback
function cwApiKey() { return ENV.CARDAPIOWEB_TOKEN || ENV.CARDAPIOWEB_API_KEY || ""; }
function cwPartnerKey() { return ENV.CARDAPIOWEB_PARTNER_KEY || ""; }

// Extrai uma lista amigável de bebidas (pra IA só oferecer o que existe)
function extractBeveragesForPrompt(raw) {
  try {
    const cats = raw?.categories || [];
    const isBeverageCat = (name) =>
      /bebida|bebidas|refrigerante|refrigerantes|refri|drink|drinks|suco|sucos|água|agua/i.test(String(name || ""));
    const out = [];
    for (const c of cats) {
      if (c?.status !== "ACTIVE") continue;
      if (!isBeverageCat(c?.name)) continue;
      for (const it of (c.items || [])) {
        if (it?.status !== "ACTIVE") continue;
        out.push(String(it.name || "").trim());
      }
    }
    const uniq = Array.from(new Set(out.filter(Boolean)));
    return uniq.slice(0, 40);
  } catch {
    return [];
  }
}

// ===================================================
// MATCHER FORTE (texto -> IDs) usando menuCache.raw
// (resolve "moda" -> "Moda da Casa - Especiais", etc.)
// ===================================================
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  const stop = new Set(["a", "o", "os", "as", "de", "da", "do", "das", "dos", "com", "e", "p", "8p", "16p", "pizza"]);
  return norm(s)
    .split(" ")
    .filter(Boolean)
    .filter(t => t.length >= 2 && !stop.has(t));
}

// sinônimos do seu negócio (adicione quando quiser)
const ALIASES = [
  { re: /\bmoda\b/i, to: "moda da casa" },
  { re: /\bcalab\b/i, to: "calabresa" },
  { re: /\bmarguerita\b/i, to: "marguerita" }, // aceita variações
  { re: /\bfiladelfia\b/i, to: "filadelfia chicken" },
  { re: /\bcatup\b/i, to: "catupiry" },
];

function applyAliases(text) {
  let t = String(text || "");
  for (const a of ALIASES) t = t.replace(a.re, a.to);
  return t;
}

// score por tokens: quanto mais tokens baterem, maior score
function scoreTokens(targetTokens, candidateTokens) {
  if (!targetTokens.length) return 0;
  const set = new Set(candidateTokens);
  let hit = 0;
  for (const t of targetTokens) if (set.has(t)) hit++;

  // bônus: se bater o primeiro token (ajuda no "moda")
  const bonus = targetTokens[0] && set.has(targetTokens[0]) ? 0.25 : 0;

  return (hit / targetTokens.length) + bonus;
}

function bestMatchByTokens(candidates, queryText, getTextFn) {
  const q = applyAliases(queryText);
  const qt = tokenize(q);
  if (!qt.length) return null;

  let best = null;
  let bestScore = 0;

  for (const c of candidates) {
    const candText = getTextFn(c);
    const ct = tokenize(candText);
    if (!ct.length) continue;

    const sc = scoreTokens(qt, ct);

    // filtro mínimo pra evitar pegar coisa errada
    if (sc >= 0.45 && sc > bestScore) {
      bestScore = sc;
      best = c;
    }
  }

  return best ? { best, score: bestScore } : null;
}

// acha item (produto) pelo nome
function findItemByNameSmart(raw, name) {
  if (!raw?.categories?.length) return null;

  const items = [];
  for (const c of raw.categories) {
    if (c?.status !== "ACTIVE") continue;
    for (const it of (c.items || [])) {
      if (it?.status !== "ACTIVE") continue;
      items.push({ cat: c, item: it });
    }
  }

  // 1) match exato normalizado
  const target = norm(applyAliases(name));
  for (const x of items) {
    if (norm(x.item.name) === target) return x;
  }

  // 2) match por tokens (fuzzy)
  const m = bestMatchByTokens(items, name, (x) => `${x.item.name} ${x.item.description || ""} ${x.cat.name || ""}`);
  return m?.best || null;
}

// acha opção dentro de um item (ex: grupo "Escolha até 2 Sabores 8P" / opção "Moda da Casa - Especiais")
function findOptionSmart(itemFromCatalog, queryOptionText) {
  const groups = itemFromCatalog?.option_groups || [];
  const optionsFlat = [];

  for (const g of groups) {
    if (g?.status !== "ACTIVE") continue;
    for (const o of (g.options || [])) {
      if (o?.status !== "ACTIVE") continue;
      optionsFlat.push({ group: g, opt: o });
    }
  }

  if (!optionsFlat.length) return null;

  // 1) exato
  const target = norm(applyAliases(queryOptionText));
  for (const x of optionsFlat) {
    if (norm(x.opt.name) === target) return x;
  }

  // 2) tokens (fuzzy) -> isso resolve "moda" pra "Moda da Casa - Especiais"
  const m = bestMatchByTokens(optionsFlat, queryOptionText, (x) => `${x.opt.name} ${x.group.name}`);
  return m?.best || null;
}

async function getMenu() {
  if (menuCache.data && Date.now() - menuCache.timestamp < CACHE_TTL) return menuCache.data;

  const apiKey = cwApiKey();
  const partnerKey = cwPartnerKey();

  if (!apiKey || !partnerKey) {
    menuCache = { data: "Cardápio indisponível.", raw: null, timestamp: Date.now() };
    return menuCache.data;
  }

  const base = ENV.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com";

  try {
    const resp = await fetch(`${base}/api/partner/v1/catalog`, {
      headers: {
        "X-API-KEY": apiKey,
        "X-PARTNER-KEY": partnerKey,
        Accept: "application/json"
      }
    });

    const data = await resp.json().catch(() => null);
    if (!data?.categories) return "Cardápio indisponível.";

    let txt = "🍕 MENU PAPPI:\n";

    data.categories.forEach((cat) => {
      if (cat?.status !== "ACTIVE") return;

      txt += `\n[CATEGORIA: ${String(cat.name || "N/A").toUpperCase()}]\n`;

      (cat.items || []).forEach((i) => {
        if (i?.status !== "ACTIVE") return;

        const basePrice = Number(i.price);
        const promoAtiva = i.promotional_price_active && i.promotional_price != null;
        const displayPrice = promoAtiva ? Number(i.promotional_price) : basePrice;
        const promoSuffix = promoAtiva ? ` (PROMO, de R$ ${basePrice.toFixed(2)})` : "";
        txt += `- ID:${i.id} | ${i.name} | R$ ${Number.isFinite(displayPrice) ? displayPrice.toFixed(2) : "0.00"}${promoSuffix}\n`;

        const groups = i.option_groups || [];
        for (const g of groups) {
          if (g?.status !== "ACTIVE") continue;
          const choiceLabel = g.choice_type === "SINGLE" ? "escolha 1" : g.choice_type === "SUMMABLE" ? "pode repetir" : "múltipla";
          const calcLabel = g.price_calculation_type === "MAX" ? "cobra maior" : g.price_calculation_type === "MEAN" ? "cobra média" : "soma";
          const reqLabel = (g.minimum_quantity || 0) >= 1 ? "obrigatório" : "opcional";
          txt += `  [GRUPO: ${g.name} | ${choiceLabel} | ${reqLabel} | ${calcLabel}]\n`;

          for (const opt of (g.options || [])) {
            if (opt?.status !== "ACTIVE") continue;
            const p = Number(opt.price);
            txt += `    -- Opção ID:${opt.id} | ${opt.name} | R$ ${Number.isFinite(p) ? p.toFixed(2) : "0.00"}\n`;
          }
        }

        // combos (se quiser visualizar)
        if (i.kind === "combo" && Array.isArray(i.combo_steps) && i.combo_steps.length) {
          txt += `  [COMBO]\n`;
          for (const step of i.combo_steps) {
            txt += `    -- Etapa: ${step.name} | Preço base: R$ ${Number(step.price || 0).toFixed(2)}\n`;
            for (const si of (step.combo_step_items || [])) {
              txt += `       * item_id:${si.item_id} | adicional: R$ ${Number(si.additional_price || 0).toFixed(2)}\n`;
            }
          }
        }
      });
    });

    menuCache = { data: txt.trim(), raw: data, timestamp: Date.now() };
    return menuCache.data;
  } catch (e) {
    return "Cardápio indisponível.";
  }
}

// ===================================================
// Pagamentos (CORRETO) - merchant/payment_methods
// ===================================================
let paymentCache = { list: null, timestamp: 0 };

async function ensurePaymentMethods() {
  if (paymentCache.list && Date.now() - paymentCache.timestamp < CACHE_TTL) return paymentCache.list;
  const list = await getPaymentMethods().catch(() => []);
  paymentCache = { list, timestamp: Date.now() };
  return list;
}

function paymentsText(list) {
  if (!Array.isArray(list) || list.length === 0) return "PIX, Cartão, Dinheiro";
  return list.map(p => `ID:${p.id} - ${p.name} (${p.kind})`).join(" | ");
}

function pickPaymentId(list, preferredPayment) {
  if (!Array.isArray(list) || list.length === 0) return null;

  if (preferredPayment === "pix") {
    return (list.find(p => String(p.kind).toLowerCase() === "pix") || list[0])?.id ?? null;
  }
  if (preferredPayment === "dinheiro") {
    return (list.find(p => String(p.kind).toLowerCase() === "money") || list[0])?.id ?? null;
  }
  if (preferredPayment === "cartao") {
    return (
      list.find(p => String(p.kind).toLowerCase() === "credit_card") ||
      list.find(p => String(p.kind).toLowerCase() === "debit_card") ||
      list[0]
    )?.id ?? null;
  }
  return list[0]?.id ?? null;
}

// ===================================================
// Totais (seguro p/ evitar 422 por centavos)
// ===================================================
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function calcItemTotal(item) {
  const base = round2(item.unit_price || 0);
  const qty = Number(item.quantity || 1);
  const optsSum = (item.options || []).reduce((acc, o) => {
    const q = Number(o.quantity || 1);
    const up = round2(o.unit_price || 0);
    return acc + round2(q * up);
  }, 0);
  return round2((base + optsSum) * qty);
}

function calcOrderAmount(payload) {
  const itemsSum = round2((payload.items || []).reduce((acc, it) => acc + round2(it.total_price || calcItemTotal(it)), 0));
  const delivery = round2(payload.totals?.delivery_fee || 0);
  const add = round2(payload.totals?.additional_fee || 0);
  const disc = round2(payload.totals?.discounts || 0);
  return round2(itemsSum + delivery + add - disc);
}

// ===================================================
// Helper - Construtor de Endereço Cardápio Web (seguro)
// ===================================================
function buildDeliveryAddressObjectFromCustomer(customer) {
  const cep = extractCep(customer?.lastAddress || "") || extractCep(customer?.lastStreet || "") || null;
  const lat = Number(customer?.lastLat);
  const lng = Number(customer?.lastLng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001;

  return {
    state: "SP",
    city: "Campinas",
    neighborhood: customer?.lastNeighborhood || "Centro",
    street: customer?.lastStreet || (customer?.lastAddress || "Rua não informada").slice(0, 150),
    number: customer?.lastNumber || null,
    complement: customer?.lastComplement || null,
    reference: null,
    postal_code: cep || null,
    coordinates: hasCoords ? { latitude: lat, longitude: lng } : null,
  };
}


function hasValidDeliveryAddressForCW(customer) {
  const cep = extractCep(customer?.lastAddress || "");
  const lat = Number(customer?.lastLat);
  const lng = Number(customer?.lastLng);
  const hasCep = !!cep && cep.length === 8;
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001;
  return { ok: hasCep && hasCoords, hasCep, hasCoords };
}

// ===================================================
// Rotas básicas
// ===================================================
router.get("/", (req, res) => res.send("Pappi API IA online 🧠✅"));
router.get("/health", (req, res) => res.json({ ok: true, app: "Pappi Pizza IA" }));

router.get("/debug/customer/:phone", async (req, res) => {
  try {
    const phone = String(req.params.phone).replace(/\D/g, "");
    const customer = await prisma.customer.findUnique({
      where: { phone },
      include: {
        orders: {
          orderBy: { createdAt: "desc" },
          take: 10,
        }
      }
    });

    if (!customer) return res.status(404).json({ ok: false, error: "Cliente não encontrado" });

    return res.json({
      ok: true,
      customer: {
        name: customer.name,
        phone: customer.phone,
        visitCount: customer.visitCount,
        preferredPayment: customer.preferredPayment,
        lastFulfillment: customer.lastFulfillment,
        lastAddress: customer.lastAddress,
        lastOrderSummary: customer.lastOrderSummary,
        preferences: customer.preferences,
        handoff: customer.handoff,
      },
      orders: customer.orders.map(o => ({
        displayId: o.displayId,
        cwOrderId: o.cwOrderId,
        status: o.status,
        total: o.total,
        items: o.items,
        createdAt: o.createdAt,
      }))
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// 👇 COLE AQUI
router.get("/debug/menu", async (req, res) => {
  try {
    if (req.query.refresh === "1") {
      menuCache = { data: null, raw: null, timestamp: 0 };
    }

    const menuText = await getMenu();
    const raw = menuCache.raw;

    return res.json({
      ok: true,
      hasRaw: !!raw,
      categoriesCount: raw?.categories?.length || 0,
      firstCategory: raw?.categories?.[0]?.name || null,
      sampleItems: (raw?.categories?.[0]?.items || []).slice(0, 5).map(i => ({
        id: i.id,
        name: i.name,
        price: i.price
      }))
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// ===================================================
// WEBHOOK CARDAPIO WEB (status/pedidos)
// ===================================================
const CW_STATUS_MSG = {
  waiting_confirmation: "⏳ Pedido recebido! Aguardando confirmação da loja...",
  confirmed:            "✅ Pedido confirmado! Já estamos preparando com carinho 🍕",
  scheduled_confirmed:  "✅ Pedido agendado e confirmado! Avisaremos quando entrar em preparo.",
  waiting_to_catch:     "🔔 Pedido pronto para retirada! Pode vir buscar 😊",
  released:             "🛵 Seu pedido saiu para entrega! Em breve estará aí.",
  closed:               "🎉 Pedido entregue! Bom apetite 😋",
  canceled:             "❌ Seu pedido foi cancelado. Qualquer dúvida é só chamar.",
};

router.post("/cardapioweb/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body || {};
    console.log("📩 CardapioWeb webhook:", JSON.stringify(body, null, 2));

    // CW manda: { event_type, order_id, order_status } OU { data: order } OU order direto
    const cwId = String(
      body.order_id || body.data?.id || body.id ||
      (Array.isArray(body.orders) ? body.orders[0]?.id : null) || ""
    ) || null;
    const status = String(
      body.order_status || body.data?.status || body.status ||
      (Array.isArray(body.orders) ? body.orders[0]?.status : null) || ""
    ).toLowerCase().replace(/-/g, "_");

    if (!status || !cwId) return;

    const msg = CW_STATUS_MSG[status];
    if (!msg) return; // status sem mensagem mapeada — ignora

    // Busca o pedido no nosso DB pelo ID do CW para obter o telefone do cliente
    const dbOrder = await prisma.order.findFirst({
      where: { cwOrderId: cwId },
      include: { customer: true },
    }).catch(() => null);

    // Fallback 1: CW incluiu customer.phone no payload do webhook
    // Fallback 2: busca o pedido completo na API do CW para obter o telefone
    let rawPhone = dbOrder?.customer?.phone || body?.customer?.phone || body?.data?.customer?.phone;
    if (!rawPhone) {
      const cwOrder = await getCwOrderById(cwId).catch(() => null);
      rawPhone = cwOrder?.customer?.phone || null;
    }

    if (!rawPhone) {
      console.warn(`⚠️ CW webhook: sem telefone para pedido cwId=${cwId} status=${status}`);
      if (dbOrder) {
        await prisma.order.update({ where: { id: dbOrder.id }, data: { status } }).catch(() => null);
      }
      return;
    }

    const digits  = String(rawPhone).replace(/\D/g, "");
    const waPhone = digits.startsWith("55") ? digits : `55${digits}`;

    await Promise.all([
      sendText(waPhone, msg),
      dbOrder
        ? prisma.order.update({ where: { id: dbOrder.id }, data: { status } }).catch(() => null)
        : Promise.resolve(),
    ]);

    // Mensagem de avaliação Google — apenas quando sai pra entrega e não está atrasado
    if (status === "released" && dbOrder) {
      const GOOGLE_REVIEW_URL = ENV.GOOGLE_REVIEW_URL || null;
      const ETA_MAX_MS = 65 * 60 * 1000; // 65 min: se passou disso, considera atrasado
      const ageMs = Date.now() - new Date(dbOrder.createdAt).getTime();
      const isLate = ageMs > ETA_MAX_MS;

      if (!isLate && GOOGLE_REVIEW_URL) {
        await new Promise(r => setTimeout(r, 3000)); // pequena pausa pra não parecer robótico
        await sendText(
          waPhone,
          `Sua pizza tá a caminho! 🍕❤️\n\nSe a experiência foi boa, nos ajuda muito com uma avaliação de *5 estrelas* no Google — leva só 10 segundinhos e faz toda diferença pra nossa equipe:\n👉 ${GOOGLE_REVIEW_URL}\n\nObrigado de coração! 😊`
        );
      }
    }
  } catch (e) {
    console.error("❌ Erro no webhook CardapioWeb:", e);
  }
});

// ===================================================
// WEBHOOK BANCO INTER (PIX)
// ===================================================
router.post("/webhook/inter", async (req, res) => {
  res.sendStatus(200);
  const pagamentos = req.body;
  if (!pagamentos || !Array.isArray(pagamentos)) return;

  try {
    for (const pag of pagamentos) {
      console.log(`💰 PIX RECEBIDO! TXID: ${pag.txid} | Valor: R$ ${pag.valor}`);

      const order = await prisma.order.findFirst({ where: { displayId: pag.txid } });
      if (!order) continue;

      await prisma.order.update({ where: { id: order.id }, data: { status: "paid" } }).catch(() => null);
      const customer = await prisma.customer.findUnique({ where: { id: order.customerId } });

      if (customer?.phone) {
        await sendText(
          customer.phone,
          `✅ *Pagamento confirmado!* Recebemos R$ ${pag.valor}.\nAgora vamos enviar seu pedido pro sistema da loja e iniciar o preparo. 🍕`
        );

        if (order.cwJson) {
          try {
            const parsedData = JSON.parse(order.cwJson);

            // Recalcular totais antes de enviar (segurança)
            if (Array.isArray(parsedData?.items)) {
              parsedData.items = parsedData.items.map((it) => {
                const fixed = { ...it };
                fixed.total_price = calcItemTotal(fixed);
                return fixed;
              });
            }
            parsedData.totals = parsedData.totals || {};
            parsedData.totals.order_amount = calcOrderAmount(parsedData);
            if (Array.isArray(parsedData?.payments) && parsedData.payments[0]) {
              parsedData.payments[0].total = parsedData.totals.order_amount;
            }

            const cwResp = await createOrder(parsedData);

            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: String(cwResp?.status || "waiting_confirmation").toLowerCase(),
                cwOrderId: cwResp?.id ? String(cwResp.id) : undefined,
              }
            }).catch(() => null);

            console.log("✅ Pedido injetado no Cardapio Web após PIX com sucesso!");

            await sendText(
              customer.phone,
              `✅ Pedido registrado no sistema da loja.\nStatus: *Aguardando confirmação / preparo*.\n⏱️ Tempo estimado: ${ETA_DELIVERY} (entrega) | ${ETA_TAKEOUT} (retirada)\nVocê vai recebendo as atualizações por aqui.`
            );
          } catch (e) {
            console.error("❌ Falha ao injetar pedido PIX no Cardapio Web:", e?.data || e);
            await sendText(
              customer.phone,
              "Tivemos uma instabilidade ao enviar pro sistema da loja 😕 Já acionei um atendente pra confirmar com você."
            );
            await setHandoffOn(customer.phone);
          }
        }
      }
    }
  } catch (error) {
    console.error("🔥 Erro webhook Inter:", error);
  }
});

// ===================================================
// WEBHOOK PRINCIPAL (WhatsApp Cloud)
// ===================================================
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  if (alreadyProcessed(msg.id)) return;

  const from = msg.from;

  try {
    let customer = await prisma.customer.findUnique({ where: { phone: from } }).catch(() => null);
    if (!customer) customer = await prisma.customer.create({ data: { phone: from } });

    if (isHandoffOn(from, customer)) return;

    // Verifica se a loja está aberta
    const storeOpen = await isStoreOpen();
    if (!storeOpen) {
      const horario = merchantCache.hoursText ? ` Hoje abrimos *${merchantCache.hoursText}*!` : "";
      await sendText(from, `😴 Estamos fechados agora!${horario}\n\nQuando abrirmos é só mandar mensagem que a gente te atende na hora 🍕`);
      return;
    }

    // --------- INTERACTIVE (botões) ----------
    if (msg.type === "interactive") {
      const btnId = msg?.interactive?.button_reply?.id || null;
      let proceedToAI = false;

      if (btnId === "REPEAT_LAST_ORDER") {
        // VIP quer repetir o pedido de sempre — lança direto pro Gemini com contexto
        pushHistory(from, "user", "BOTÃO: repetir pedido de sempre");
        // Garante que fulfillment esteja setado
        if (!customer.lastFulfillment) {
          await askFulfillmentButtons(from);
          return;
        }
        // Injeta o histórico como contexto pra IA montar o pedido automaticamente
        pushHistory(from, "user", `[Cliente quer repetir: ${customer.lastOrderSummary}]`);
        await sendText(from, `Ótimo! 🍕 Vou preparar *${customer.lastOrderSummary?.split(",")[0]}* pra você. Só confirma: o endereço e pagamento continuam os mesmos?`);
        return;
      }

      if (btnId === "HELP_HUMAN") {
        pushHistory(from, "user", "BOTÃO: atendente");
        await setHandoffOn(from);
        await sendText(from, "Perfeito ✅ Já chamei um atendente pra continuar aqui com você.");
        return;
      }

      if (btnId === "HELP_BOT") {
        pushHistory(from, "user", "BOTÃO: continuar");
        await askFulfillmentButtons(from); // já tem texto no botão
        return;
      }

      if (btnId === "FULFILLMENT_ENTREGA" || btnId === "FULFILLMENT_RETIRADA") {
        const v = btnId === "FULFILLMENT_ENTREGA" ? "entrega" : "retirada";
        const prevF = customer.lastFulfillment;
        const isReturning = (customer.visitCount || 0) > 0;
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastFulfillment: v, lastInteraction: new Date() }
        }).catch(() => customer);
        pushHistory(from, "user", `BOTÃO: ${v}`);

        if (v === "retirada") {
          let msg;
          if (isReturning && prevF === "retirada") {
            msg = `Já anotei! Vem buscar aqui então 🏪😄\n⏱️ *${ETA_TAKEOUT}* — me faz o pedido!`;
          } else if (isReturning && prevF === "entrega") {
            msg = `Hoje você mesmo vem até a gente! 🏪 Ótimo!\n⏱️ *${ETA_TAKEOUT}* — me faz o pedido!`;
          } else {
            msg = `Ótimo, retirada! 🏪 ⏱️ *${ETA_TAKEOUT}*.\nMe faz o pedido 🍕 (tamanho + sabor)`;
          }
          await sendText(from, msg);
          return;
        }

        // entrega — se tiver endereço salvo, mostra com botões em vez de pedir de novo
        if (customer.lastAddress && customer.lastStreet) {
          const endFormatado = [
            customer.lastStreet,
            customer.lastNumber,
            customer.lastNeighborhood,
            "Campinas - SP",
          ].filter(Boolean).join(", ");

          let intro;
          if (isReturning && prevF === "entrega") {
            intro = `🛵 Delivery! ⏱️ *${ETA_DELIVERY}*\n\nVai ser neste endereço?`;
          } else {
            intro = `🛵 Entrega! ⏱️ *${ETA_DELIVERY}*\n\nVai ser neste endereço?`;
          }

          await sendButtons(from,
            `${intro}\n\n📍 ${endFormatado}`,
            [
              { id: "ADDR_USE_SAVED", title: "✅ É este!" },
              { id: "ADDR_NEW",       title: "📍 Outro endereço" },
            ]
          );
          return;
        }

        // sem endereço salvo
        let msgE;
        if (isReturning && prevF === "retirada") {
          msgE = `Delivery hoje! 🛵 ⏱️ *${ETA_DELIVERY}*.\nMe manda o endereço ou sua localização 📍`;
        } else {
          msgE = `🛵 Entrega! ⏱️ *${ETA_DELIVERY}*.\nMe manda o *CEP* ou *Rua + Número + Bairro* (ou localização 📍) pra calcular a taxa`;
        }
        await sendText(from, msgE);
        return;
      }

      if (btnId === "ADDR_USE_SAVED") {
        // Cliente confirmou o endereço salvo — pula o fluxo de CEP
        pushHistory(from, "user", `BOTÃO: confirmou endereço salvo (${customer.lastAddress})`);
        await sendText(from, `Perfeito! 📍 Endereço confirmado.\nAgora me faz o pedido 🍕`);
        return;
      }

      if (btnId === "ADDR_NEW") {
        pushHistory(from, "user", "BOTÃO: quer outro endereço");
        await sendText(from, `Tudo bem! Me manda o novo endereço 📍\nCEP, ou Rua + Número + Bairro, ou sua localização`);
        return;
      }

      if (btnId === "PAY_PIX" || btnId === "PAY_CARTAO" || btnId === "PAY_DINHEIRO") {
        const v = btnId === "PAY_PIX" ? "pix" : btnId === "PAY_CARTAO" ? "cartao" : "dinheiro";
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { preferredPayment: v, lastInteraction: new Date() }
        }).catch(() => customer);
        pushHistory(from, "user", `BOTÃO: pagamento ${v}`);

        const payDraft = getDraft(from);
        if (payDraft) {
          proceedToAI = true;
          msg.type = "text";
          if (!msg.text) msg.text = {};
          msg.text.body = payDraft.text;
        }
      }

      if (btnId === "ADDR_CONFIRM") {
        const af = getAF(from);
        // Se af.pending foi perdido (restart do servidor), usa o que já estava salvo no customer
        const formatted = af?.pending?.formatted || customer.lastAddress || null;
        const lat = af?.pending?.lat ?? customer.lastLat;
        const lng = af?.pending?.lng ?? customer.lastLng;

        if (formatted) {
          await prisma.customer.update({
            where: { phone: from },
            data: {
              lastAddress: String(formatted).slice(0, 200),
              lastLat: lat != null ? Number(lat) : customer.lastLat,
              lastLng: lng != null ? Number(lng) : customer.lastLng,
              lastStreet: af.street ? String(af.street).slice(0, 150) : customer.lastStreet,
              lastNumber: af.number ? String(af.number).slice(0, 20) : customer.lastNumber,
              lastNeighborhood: af.bairro ? String(af.bairro).slice(0, 100) : customer.lastNeighborhood,
              lastComplement: af.complemento ? String(af.complemento).slice(0, 100) : customer.lastComplement,
              lastInteraction: new Date()
            }
          }).catch(() => null);

          pushHistory(from, "user", `ENDEREÇO CONFIRMADO: ${formatted}`);
        }

        resetAF(from);
        await sendText(from, "Fechado ✅ Agora me diga seu pedido 🍕 (tamanho + sabor, ou meia a meia)");
        return;
      }

      if (btnId === "ADDR_CORRECT") {
        resetAF(from);
        await sendText(from, "Me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍).");
        return;
      }

      if (btnId === "ORDER_ADD") {
        const pending = pendingNewOrder.get(from);
        pendingNewOrder.delete(from);
        if (!pending) {
          await sendText(from, "Nao encontrei o pedido pendente. Me diz o que quer acrescentar.");
          return;
        }
        // Cria o pedido com observacao indicando que e acrescimo
        const activeOrder = await prisma.order.findFirst({
          where: { customerId: customer.id, status: { in: ["waiting_confirmation", "confirmed"] } },
          orderBy: { createdAt: "desc" }
        }).catch(() => null);
        const obsPrefix = activeOrder ? `ACRESCENTAR AO PEDIDO #${activeOrder.displayId} - ` : "ACRESCIMO - ";
        pending.payload.observation = obsPrefix + (pending.payload.observation || "Pedido via WhatsApp");
        try {
          const cwResp = await createOrder(pending.payload);
          await prisma.order.create({
            data: {
              displayId: pending.txid,
              cwOrderId: cwResp?.id ? String(cwResp.id) : undefined,
              status: String(cwResp?.status || "waiting_confirmation").toLowerCase(),
              total: pending.payload.totals.order_amount,
              items: "Acrescimo ao pedido",
              customerId: customer.id
            }
          }).catch(() => null);
          await sendText(from, `Anotado. O item foi enviado com a observacao "${obsPrefix}" pra cozinha nao duplicar.`);
        } catch (e) {
          await sendText(from, "Erro ao enviar o acrescimo. Tenta de novo ou chama um atendente.");
        }
        clearDraft(from);
        return;
      }

      if (btnId === "ORDER_NEW") {
        const pending = pendingNewOrder.get(from);
        pendingNewOrder.delete(from);
        if (!pending) {
          await sendText(from, "Nao encontrei o pedido pendente. Me diz o que quer pedir.");
          return;
        }
        try {
          const cwResp = await createOrder(pending.payload);
          const receipt = buildOrderReceipt({ payload: pending.payload, customer, displayId: pending.txid, cwDisplayId: cwResp?.display_id || cwResp?.id, payList: null });
          await prisma.order.create({
            data: {
              displayId: pending.txid,
              cwOrderId: cwResp?.id ? String(cwResp.id) : undefined,
              status: String(cwResp?.status || "waiting_confirmation").toLowerCase(),
              total: pending.payload.totals.order_amount,
              items: "Novo pedido separado",
              customerId: customer.id
            }
          }).catch(() => null);
          await sendText(from, receipt);
          await sendText(from, "Pedido separado enviado. Aguardando confirmacao da loja.");
        } catch (e) {
          await sendText(from, "Erro ao enviar o pedido. Tenta de novo ou chama um atendente.");
        }
        clearDraft(from);
        return;
      }

      if (!proceedToAI) {
        if (!customer.name && !askedName.has(from)) {
          askedName.add(from);
          await sendText(from, "Show 😊 qual seu nome?");
          return;
        }
        if (!customer.lastFulfillment) { await askFulfillmentButtons(from); return; }
        if (customer.lastFulfillment === "entrega" && !customer.lastAddress) {
          await sendText(from, "Pra entrega, me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍) pra eu calcular a taxa 😊");
          return;
        }
        await sendText(from, "Fechado 🙌 Qual pizza você quer? (tamanho + sabor, ou meia a meia)");
        return;
      }
    }

    // --------- LOCATION ----------
    if (msg.type === "location") {
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;

      if (!lat || !lng) {
        await sendText(from, "Não consegui ler sua localização 😕 Manda de novo?");
        return;
      }

      if (!customer.lastFulfillment) {
        customer = await prisma.customer.update({
          where: { phone: from },
          data: { lastFulfillment: "entrega", lastInteraction: new Date() }
        }).catch(() => customer);
      }

      const formatted = await reverseGeocodeLatLng(lat, lng);
      if (!formatted) {
        const fallback = `Localização recebida 📍 (GPS: ${lat}, ${lng})`;
        const af = getAF(from);
        af.pending = { formatted: fallback, lat, lng };
        await askAddressConfirm(from, fallback, null);
        return;
      }

      const deliveryGPS = await safeQuote(formatted);
      const af = getAF(from);
      af.pending = { formatted, lat, lng };
      af.delivery = deliveryGPS || null;

      if (deliveryGPS?.ok && deliveryGPS.within === false) {
        await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`);
        return;
      }

      await askAddressConfirm(from, formatted, deliveryGPS || null);
      return;
    }

    // --------- AUDIO ----------
    if (msg.type === "audio" || msg.type === "voice") {
      const mediaId = msg.audio?.id || msg.voice?.id;
      if (!mediaId) return;

      await sendText(from, "🎧 Ouvi seu áudio, só um segundo...");

      try {
        const { downloadWhatsAppMedia } = require("../services/media.service");
        const base64Audio = await downloadWhatsAppMedia(mediaId);
        if (!base64Audio) throw new Error("download falhou");

        const apiKey = ENV.GEMINI_API_KEY || "";
        const model = await ensureGeminiModel(false);
        const transcribeResp = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: "Transcreva exatamente o que foi dito neste áudio em português. Responda apenas com o texto transcrito, sem comentários." },
                { inline_data: { mime_type: "audio/ogg", data: base64Audio } }
              ]
            }]
          })
        });
        const transcribeData = await transcribeResp.json().catch(() => ({}));
        const transcribed = transcribeData?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("").trim();

        if (!transcribed) throw new Error("transcrição vazia");

        console.log(`🎙️ Áudio transcrito [${from}]: ${transcribed}`);
        // Reprocessa como mensagem de texto
        msg.type = "text";
        msg.text = { body: transcribed };
      } catch (e) {
        console.error("❌ Erro ao transcrever áudio:", e.message);
        await sendText(from, "Não consegui ouvir o áudio 😕 Pode digitar sua mensagem?");
        return;
      }
    }

    // --------- TEXT ----------
    if (msg.type !== "text") return;

    const userText = msg.text?.body || "";
    if (!userText) return;

    // rapport 1x (se for saudação)
    if (!greeted.has(from) && isGreetingText(userText)) {
      greeted.add(from);
      pushHistory(from, "user", userText);
      await sendRapport(from, customer);
      return;
    }

    if (detectHumanRequest(userText) || detectIrritation(userText) || detectLoop(from)) {
      pushHistory(from, "user", userText);
      await askDeescalationButtons(from); // texto já está no botão
      return;
    }

    if (detectCancelRequest(userText)) {
      pushHistory(from, "user", userText);
      const CANCEL_WINDOW_MS = 12 * 60 * 1000; // 12 minutos
      const lastOrder = await prisma.order.findFirst({
        where: { customerId: customer.id, status: { not: { in: ["canceled", "delivered"] } } },
        orderBy: { createdAt: "desc" }
      }).catch(() => null);

      if (!lastOrder) {
        await sendText(from, "Não encontrei nenhum pedido ativo. Se precisar de ajuda é só chamar! 😊");
        return;
      }

      const ageMs = Date.now() - new Date(lastOrder.createdAt).getTime();
      const withinWindow = ageMs <= CANCEL_WINDOW_MS;
      const cancellable = withinWindow && ["waiting_confirmation", "confirmed"].includes(lastOrder.status);

      if (!cancellable) {
        const reason = !withinWindow
          ? "já passou do prazo de cancelamento (12 min)"
          : `o pedido está com status *${lastOrder.status}* e já pode estar em preparo`;
        await sendText(from, `Infelizmente não consigo cancelar automaticamente — ${reason}.\nVou chamar um atendente para verificar com a loja. 📞`);
        await setHandoffOn(from);
        return;
      }

      if (lastOrder.cwOrderId) {
        const result = await cancelOrder(lastOrder.cwOrderId);
        if (result.ok) {
          await prisma.order.update({ where: { id: lastOrder.id }, data: { status: "canceled" } }).catch(() => null);
          await sendText(from, `✅ Pedido *#${lastOrder.displayId}* cancelado com sucesso! Se precisar de mais alguma coisa é só chamar. 😊`);
        } else {
          await sendText(from, `Não consegui cancelar automaticamente 😕 Vou chamar um atendente pra resolver agora. 📞`);
          await setHandoffOn(from);
        }
      } else {
        await sendText(from, `Vou chamar um atendente pra cancelar o pedido *#${lastOrder.displayId}*. 📞`);
        await setHandoffOn(from);
      }
      return;
    }

    const nm = extractNameLight(userText);
    const ff = detectFulfillmentLight(userText);
    const pay = detectPaymentLight(userText);

    const dataToUpdate = { lastInteraction: new Date() };
    if (nm && !customer.name && !looksLikeGarbageName(nm)) dataToUpdate.name = nm;
    if (ff) dataToUpdate.lastFulfillment = ff;
    if (pay) dataToUpdate.preferredPayment = pay;

    customer = await prisma.customer.update({ where: { phone: from }, data: dataToUpdate }).catch(() => customer);
    pushHistory(from, "user", userText);

    if (shouldAskName(from, customer) && isGreetingText(userText)) {
      await sendText(from, "Pra eu te atender certinho 😊 me diz seu *nome*? (ex: Dony)");
      return;
    }

    if (!customer.name && nm && looksLikeGarbageName(nm)) {
      await sendText(from, "Me diz seu *nome* por favor? 😊 (ex: Dony)");
      return;
    }

    if (!customer.lastFulfillment) {
      if (!greeted.has(from)) {
        greeted.add(from);
      }
      await sendButtons(from,
        `Cardápio: ${LINK_CARDAPIO}\n⏱️ Entrega ${ETA_DELIVERY} | Retirada ${ETA_TAKEOUT}\n\nComo vai ser?`,
        [{ id: "FULFILLMENT_ENTREGA", title: "🚚 Entrega" }, { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" }]
      );
      return;
    }

    if (!looksLikeAddress(userText) && looksLikeOrderIntent(userText)) setDraft(from, userText);

    // Se cliente menciona que falta número no endereço → reinicia fluxo de endereço
    if (customer.lastFulfillment === "entrega" && /falta.{0,10}n[uú]mero|sem n[uú]mero|n[uú]mero errado|endere[cç]o errado|corrigir endere[cç]o/i.test(userText)) {
      await prisma.customer.update({ where: { phone: from }, data: { lastAddress: null, lastLat: null, lastLng: null } }).catch(() => null);
      customer = { ...customer, lastAddress: null, lastLat: null, lastLng: null };
      resetAF(from);
      await sendText(from, "Sem problema! 😊 Me manda o *CEP* novamente pra eu corrigir o endereço.");
      return;
    }

    // -----------------------------------------
    // Fluxo endereço guiado (quando entrega sem endereço)
    // -----------------------------------------
    let currentFee = 0;

    if (customer.lastFulfillment === "entrega" && !customer.lastAddress) {
      const af = getAF(from);
      const t = String(userText || "").trim();

      if (!af.step && !looksLikeAddress(t) && looksLikeOrderIntent(userText)) {
        await sendText(from, `Pra entrega, me manda *CEP* ou *Rua + Número + Bairro* (ou sua localização 📍) pra eu calcular a taxa 😊\n(Cardápio: ${LINK_CARDAPIO})`);
        return;
      }

      // Nome de rua sem prefixo (ex: "Manoel Carvalho Guerra Junior") — 3+ palavras só letras
      if (!af.step && !looksLikeAddress(t) && !looksLikeOrderIntent(t)) {
        const words = t.split(/\s+/).filter(Boolean);
        const isPossibleStreet = words.length >= 3 && /^[A-Za-zÀ-ÿ\s]+$/.test(t);
        const isJustNumber = /^\d+$/.test(t) && af.street;
        if (isJustNumber) {
          af.number = t;
          af.step = "ASK_BAIRRO";
          await sendText(from, "Boa! Qual o *bairro*?");
          return;
        }
        if (isPossibleStreet) {
          af.street = t;
          af.step = "ASK_NUMBER";
          await sendText(from, `📍 *${t}* — qual o *número* da casa?`);
          return;
        }
      }

      const cep = extractCep(t);
      if (cep) {
        af.cep = cep;
        // Busca rua e bairro automaticamente pelo ViaCEP
        try {
          const viacep = await fetch(`https://viacep.com.br/ws/${cep}/json/`).then(r => r.json()).catch(() => null);
          if (viacep && !viacep.erro && viacep.logradouro) {
            af.street = viacep.logradouro;
            af.bairro = viacep.bairro || "";
            af.step = "ASK_NUMBER";
            await sendText(from, `Perfeito ✅ *${viacep.logradouro}* — ${viacep.bairro || viacep.localidade}\nQual o *número* da casa?`);
            return;
          }
        } catch (_) {}
        // Fallback: CEP não encontrado no ViaCEP, pede número e depois bairro
        af.step = "ASK_NUMBER";
        await sendText(from, "Perfeito ✅ Qual o *número* da casa?");
        return;
      }

      if (af.step === "ASK_NUMBER") {
        const n = extractHouseNumber(t);
        if (!n) { await sendText(from, "Me diz só o *número* da casa 😊"); return; }
        af.number = n;
        // Tenta geocodificar direto com rua + número
        const qNum = buildAddressText(af);
        const dNum = await safeQuote(qNum);
        if (dNum?.ok) {
          if (dNum.within === false) { await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`); return; }
          af.pending = { formatted: dNum.formatted, lat: dNum.lat, lng: dNum.lng };
          af.step = null;
          await askAddressConfirm(from, dNum.formatted, dNum);
        } else {
          af.step = "ASK_BAIRRO";
          await sendText(from, "Qual o *bairro*? 😊");
        }
        return;
      }

      if (af.step === "ASK_BAIRRO") {
        af.bairro = t.slice(0, 80);
        const qBairro = buildAddressText(af);
        const dBairro = await safeQuote(qBairro);
        if (dBairro?.ok) {
          if (dBairro.within === false) { await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`); return; }
          af.pending = { formatted: dBairro.formatted, lat: dBairro.lat, lng: dBairro.lng };
          af.step = null;
          await askAddressConfirm(from, dBairro.formatted, dBairro);
        } else {
          af.step = "ASK_COMPLEMENTO";
          await sendText(from, "Tem *complemento*? Se não tiver, diga *sem*.");
        }
        return;
      }

      if (af.step === "ASK_COMPLEMENTO") {
        af.complemento = looksLikeNoComplement(t) ? null : t.slice(0, 120);
        af.step = null;

        const full = buildAddressText(af);
        const d2 = await safeQuote(full);

        if (!d2?.ok) { af.pending = { formatted: full }; await askAddressConfirm(from, full, null); return; }
        if (d2.within === false) { await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`); return; }

        af.pending = { formatted: d2.formatted, lat: d2.lat, lng: d2.lng };
        await askAddressConfirm(from, d2.formatted, d2);
        return;
      }

      if (looksLikeAddress(t)) {
        const delivery = await safeQuote(t);
        if (delivery?.ok) {
          if (delivery.within === false) { await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`); return; }
          const formatted = delivery.formatted || t;
          const af2 = getAF(from);
          af2.pending = { formatted, lat: delivery.lat, lng: delivery.lng };
          await askAddressConfirm(from, formatted, delivery);
          return;
        }

        const num = extractHouseNumber(t);
        if (!num) {
          af.street = t.slice(0, 120);
          af.step = "ASK_NUMBER";
          await sendText(from, "Perfeito 🙌 Agora me diga o *número*.\nSe preferir, mande seu *CEP* ou *localização 📍*.");
          return;
        }

        af.street = t.slice(0, 120);
        af.number = num;
        const qInline = buildAddressText(af);
        const dInline = await safeQuote(qInline);
        if (dInline?.ok) {
          if (dInline.within === false) { await sendText(from, `Ainda não entregamos aí (até ${MAX_KM} km). Quer *Retirada*?`); return; }
          af.pending = { formatted: dInline.formatted, lat: dInline.lat, lng: dInline.lng };
          await askAddressConfirm(from, dInline.formatted, dInline);
        } else {
          af.step = "ASK_BAIRRO";
          await sendText(from, "Show! Qual é o *bairro*? 😊");
        }
        return;
      }

      // Catch-all: mensagem não reconhecida dentro do fluxo de endereço
      await sendText(from, "Pra calcular a taxa de entrega, me manda o *CEP* (ex: 13051135) ou *Rua + Número + Bairro* (ou sua localização 📍) 😊");
      return;
    }

    // -----------------------------------------
    // taxa de entrega (se já tem endereço) — cache 30 min por endereço
    // -----------------------------------------
    if (customer.lastFulfillment === "entrega" && customer.lastAddress) {
      const cacheKey = customer.lastAddress;
      const cached = feeCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
        currentFee = cached.fee;
      } else {
        const finalCota = await safeQuote(customer.lastAddress);
        currentFee = finalCota?.fee != null ? Number(finalCota.fee) : 0;
        feeCache.set(cacheKey, { fee: currentFee, ts: Date.now() });
        if (feeCache.size > 500) feeCache.clear();
      }
    }

    if (!customer.preferredPayment) {
      if (!(customer.lastFulfillment === "entrega" && !customer.lastAddress)) {
        await askPaymentButtons(from);
        return;
      }
    }

    if (!customer.name) { await sendText(from, "Antes de continuar 😊 qual seu *nome*?"); return; }

    // ===================================================
    // Pega menu + pagamentos corretos
    // ===================================================
    const [menu, payList] = await Promise.all([getMenu(), ensurePaymentMethods()]);
    const pagamentosLoja = paymentsText(payList);
    const beveragesList = extractBeveragesForPrompt(menuCache.raw);

    // Obter CHAVE PIX do sistema
    const configPix = await prisma.config.findUnique({ where: { key: "CHAVE_PIX" } }).catch(() => null);
    const pixKey = configPix?.value || "19983193999";

    const mode = getMode({ customer, now: new Date() });
    const RULES = loadRulesFromFiles(mode);
    const historyText = getHistoryText(from);
    const upsell = getUpsellHint({ historyText, userText });
    const pedidoTxt = getDraft(from)?.text || "";

    // Filtra sugestoes contra o menu real (evita sugerir pizza em falta ou inativa)
    const menuRawItems = (menuCache.raw?.categories || [])
      .flatMap(c => c.items || [])
      .filter(i => i.status === "ACTIVE")
      .map(i => i.name.toLowerCase());

    const norm = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const isInMenu = name => menuRawItems.some(m => norm(m).includes(norm(name.split(" ")[0])) || norm(name).split(" ").slice(0,2).every(w => norm(m).includes(w)));

    const topPizzasDisponiveis = TOP_PIZZAS.filter(p => isInMenu(p.name));
    const combosSalgadosDisponiveis = COMBOS_SALGADAS.filter(c =>
      c.split("+").every(part => {
        const sabor = part.replace(/1\/2/g, "").trim();
        return isInMenu(sabor);
      })
    );
    const combosDocesDisponiveis = COMBOS_DOCES.filter(c =>
      c.split("+").every(part => {
        const sabor = part.replace(/1\/2/g, "").trim();
        return isInMenu(sabor);
      })
    );

    const disc = detectDISC(historyText, userText);
    const tone = discToneGuidance(disc);

    // Detectar e salvar preferências novas durante a conversa
    const prefDetected = detectNewPreferences(userText, customer.preferences || "");
    if (prefDetected) {
      const updatedPrefs = mergePreferences(customer.preferences || "", prefDetected);
      customer = await prisma.customer.update({
        where: { phone: from },
        data: { preferences: updatedPrefs }
      }).catch(() => customer);
    }

    // Montar contexto de memória do cliente para o prompt
    const isReturning = (customer.visitCount || 0) > 0;
    const customerMemory = isReturning
      ? `CLIENTE FIEL (${customer.visitCount} pedido${customer.visitCount > 1 ? "s" : ""} anteriores):
- Último pedido: ${customer.lastOrderSummary || "não registrado"}
- Preferências detectadas: ${customer.preferences || "nenhuma ainda"}
- AÇÃO: Se o cliente não mencionou o que quer pedir ainda, pergunte se quer repetir o último pedido ou ver novidades. Ex: "Vai querer a mesma ${customer.lastOrderSummary?.split(",")[0] || "pizza"} de sempre? 😊"`
      : `PRIMEIRO PEDIDO - seja extra acolhedor e paciente. Explique brevemente como funciona.`;

    const paymentMethodIdPicked = pickPaymentId(payList, customer.preferredPayment);

    const deliveryInternal =
      customer.lastFulfillment === "entrega"
        ? `ENTREGA (interno): Taxa atual R$ ${Number(currentFee).toFixed(2)}`
        : `RETIRADA (interno): sem taxa`;

    // ===================================================
    // PROMPT
    // ===================================================
    const PROMPT = `
Você atende como humano da Pappi Pizza (Campinas-SP). Não diga que é robô. Fale natural e simpático.
${tone}

${customerMemory}

FOCO ABSOLUTO NO PEDIDO:
- Você é um atendente de pizzaria. Seu único objetivo é receber o pedido e fechar a venda.
- Se o cliente mandar algo fora do contexto (piada, pergunta aleatória, assunto não relacionado), responda de forma breve e simpática e IMEDIATAMENTE redirecione pro pedido.
- Exemplos de redirecionamento: "haha, boa! Mas vamos lá, o que você vai pedir?" | "Que isso! Mas vamos fechar seu pedido, que tal?"
- NUNCA entre em conversas longas fora do pedido. Max 1 frase fora do contexto, depois volta pro roteiro.
- Se o cliente perguntar algo sobre a loja (endereço, horário, ingredientes), responda brevemente e volte pro pedido.

QUANDO O CLIENTE PEDIR O CARDAPIO:
- O link já foi enviado na saudação. NAO mande o link de novo sem motivo.
- Se for cliente novo: "O cardapio ta aqui: ${LINK_CARDAPIO} Ja tem algo em mente ou quer uma sugestao?"
- Se for cliente fiel com historico: NAO mande o link de cara. Diga "Da ultima vez voce foi de [ultimo pedido], quer repetir ou experimentar algo novo?" — so mande o link se ele pedir de novo.
- Sempre termine com uma pergunta que direcione pro fechamento do pedido.

RESPOSTAS CURTAS - REGRA DE OURO:
- NUNCA liste todas as opções de sabores disponíveis. As pessoas não leem textos longos no WhatsApp.
- Quando o cliente pedir um sabor genérico (ex: "frango", "calabresa"), responda diretamente com o sabor mais popular: "Frango com Catupiry" ou "Calabresa Tradicional". Se ele quiser outro, ele fala.
- Exemplo CORRETO: Cliente: "meia frango meia calabresa" → Você: "Fechado! Frango com Catupiry e Calabresa Tradicional? Quer adicionar borda ou bebida?"
- Exemplo ERRADO: listar 5 opções de frango para o cliente escolher.
- Só pergunte o sabor exato se o cardápio tiver DOIS ou menos sabores daquela categoria.
- Máximo 2 perguntas por mensagem. Se precisar de mais info, pegue a mais importante primeiro.

REGRAS DE ATENDIMENTO (MUITO IMPORTANTE):
- Já sabemos: Nome: ${customer.name} | Envio: ${customer.lastFulfillment} | Pagamento (preferência): ${customer.preferredPayment || "não definido"}
- Tempo estimado: entrega ${ETA_DELIVERY} | retirada ${ETA_TAKEOUT}
- Taxa de entrega atual: R$ ${Number(currentFee).toFixed(2)}
- PROIBIDO FALAR IDs: NUNCA diga os códigos dos produtos (ex: "ID:123") para o cliente na conversa.
- PROIBIDO PEDIR TELEFONE: NUNCA peça número de telefone ao cliente. Quando o cliente mencionar "número", "falta número" ou similar no contexto de pedido/entrega, é SEMPRE o número da casa/endereço, jamais telefone. Esses códigos são estritamente secretos e servem apenas para você preencher o JSON final.
- PROIBIDO EXPLICAR REGRA DE PREÇO: Se for meio a meio, NÃO diga “cobra o mais caro”/“pelo mais caro”. Apenas informe o TOTAL final.
- BEBIDAS: Ofereça somente bebidas que existam na lista "BEBIDAS DISPONÍVEIS" abaixo.
- SABORES GENÉRICOS: Se o cliente pedir "frango" e existir mais de um frango no cardápio, liste as opções (sem IDs) e pergunte qual prefere.
- 1 pergunta por vez.
- Se o cliente ainda não escolheu tamanho + sabores, conduza pra isso.
- Sempre que fizer RESUMO final, peça confirmação: "Posso confirmar?"

SUGESTAO ESTRATEGICA (gatilhos psicologicos):
Dica atual do sistema: ${upsell || "nenhuma"}

Pizzas prioritarias para sugerir (maior lucro e mais pedidas — use estas quando o cliente estiver indeciso ou pedir sugestao):
${topPizzasDisponiveis.map((p, i) => `${i + 1}. ${p.name} - ${p.tag}`).join("\n") || "Consulte o cardapio."}

Quando o cliente pedir sugestao ou parecer indeciso:
- Sugira 2 das pizzas prioritarias acima com prova social. Ex: "A Costela com Catupiry e Pimenta Biquinho e muito elogiada, e a Frango com Catupiry e classica. Qual te agrada mais?"
- Nunca liste mais de 3 opcoes de uma vez.

Combos meia a meia salgada mais pedidos (apenas os disponiveis agora):
${combosSalgadosDisponiveis.slice(0, 3).join(" | ") || "Consulte o cardapio."}

Combos doces mais pedidos (apenas os disponiveis agora):
${combosDocesDisponiveis.join(" | ") || "Consulte o cardapio."}

ANCORA DE TAMANHO (use sempre apos o cliente escolher o sabor):
- "A maioria pede a de 16 pedacos — compensa mais e da pra dividir melhor. Voce prefere 8 ou 16?"
- NUNCA pergunte tamanho sem ancorar no 16 como mais popular.

UPSELL DE DOCE (use apos fechar o pedido principal, antes do resumo):
- Se o cliente nao pediu pizza doce, sugira uma: "Quer aproveitar e fechar com uma pizza doce? As favoritas sao Duo (chocolate ao leite + branco) e Charge (chocolate, doce de leite e amendoim)."
- So pergunte UMA VEZ. Se recusar, aceite e siga.

UPSELL DE BORDA E BEBIDA:
- Apos escolher a pizza, sugira borda com frase curta e emocional. Ex: "Borda de catupiry faz toda diferenca nessa pizza 🤤 Quer adicionar?"
- Se tiver pedido pizza grande, sugira Coca 2L. Ex: "Coca 2L pra acompanhar?"
- Uma sugestao por vez, nunca as duas juntas.

ROTEIRO:
1) Confirme tamanho (ancora no 16) + sabores
2) Ofereça borda com frase emocional + 1 bebida
3) Sugira doce (1x apenas)
4) Pergunte observacoes
5) Se dinheiro, pergunte troco
6) Faca resumo e total exato (inclui taxa R$ ${Number(currentFee).toFixed(2)})

IMPORTANTE SOBRE STATUS:
- Quando o pedido for criado via integração, ele entra como "aguardando confirmação/preparo".
- NÃO diga "motoboy a caminho" nem "pedido entregue" nem "já está saindo" após criar.
- A mensagem certa após criar é: "Pedido registrado no sistema e seguindo para confirmação/preparo. Você receberá atualização de status por aqui."

FINALIZAÇÃO:
Quando o cliente disser SIM/CONFIRMAR para o resumo, gere um bloco JSON final dentro de \`\`\`json.

REGRA CRÍTICA DE PREÇOS NO JSON:
- Pizzas e itens com grupos de opção (sabores, bordas): "unit_price" do ITEM = 0. O preço vai nas OPTIONS.
- Itens simples sem opções (bebidas, adicionais avulsos): "unit_price" do ITEM = preço real.
- NUNCA duplique o preço (item + opção ao mesmo tempo).

Formato:
\`\`\`json
{
  "order_confirmation": true,
  "order_type": "${customer.lastFulfillment === 'entrega' ? 'delivery' : 'takeout'}",
  "observation": "Observações do cliente",
  "total_order_amount": VALOR_TOTAL_NUMERICO,
  "delivery_fee": ${customer.lastFulfillment === 'entrega' ? Number(currentFee).toFixed(2) : 0},
  "payment_method_id": ${paymentMethodIdPicked ?? "ID_INTEIRO_DO_PAGAMENTO"},
  "change_for": VALOR_TROCO_OU_NULL,
  "items": [
    {
      "item_id": "ID_DO_PRODUTO",
      "name": "NOME DO ITEM",
      "quantity": 1,
      "unit_price": 0,
      "observation": "obs específica do item (ex: sem cebola, bem passado). NAO coloque 'meio a meio' ou 'metade X metade Y' pois os sabores já estão nas options.",
      "options": [
        {
          "option_id": "ID_DA_OPCAO",
          "name": "NOME DA OPCAO",
          "quantity": 1,
          "unit_price": PRECO_DA_OPCAO
        }
      ]
    }
  ]
}
\`\`\`

PAGAMENTOS DISPONÍVEIS:
${pagamentosLoja}

BEBIDAS DISPONÍVEIS (só ofereça essas):
${beveragesList.length ? beveragesList.map((b) => `- ${b}`).join("\n") : "- (indisponível no momento)"}

${deliveryInternal}

CARDÁPIO (IDs e preços reais):
${menu}

HISTÓRICO:
${historyText}
`.trim();

    const content = `${PROMPT}\n\nCliente: ${userText}\nAtendente:`;
    let resposta = "";

    try {
      resposta = await geminiGenerate(content);
    } catch (e) {
      console.error("❌ Gemini falhou definitivamente:", e?.message || e);
      await sendText(from, "Estou com muitas mensagens agora 😅 Me diga apenas o *tamanho* e os *sabores* da pizza que quer pedir, por favor.\nCardápio: " + LINK_CARDAPIO);
      return;
    }

    // ===================================================
    // EXTRAÇÃO DO JSON DA IA
    // ===================================================
    let jsonMatch = resposta.match(/```json([\s\S]*?)```/);
    let orderDataFromIA = null;

    if (jsonMatch && jsonMatch[1]) {
      try {
        orderDataFromIA = JSON.parse(jsonMatch[1].trim());
        resposta = resposta.replace(jsonMatch[0], "").trim();
      } catch (e) {
        console.error("Erro ao fazer parse do JSON da IA:", e);
      }
    }

    let finalOrderPayload = null;
    let txid = `PAPPI${Date.now()}`;

    // ===================================================
    // Se IA confirmou: montar payload final Cardápio Web
    // ===================================================
    if (orderDataFromIA && orderDataFromIA.order_confirmation === true) {
      let itemsFormatados = [];
      let sumItems = 0;

      if (Array.isArray(orderDataFromIA.items)) {
        itemsFormatados = orderDataFromIA.items.map(item => {
          let optionsSum = 0;
          let optionsFormatted = [];

          if (item.options && Array.isArray(item.options)) {
            optionsFormatted = item.options.map(opt => {
              const optPrice = round2(parseFloat(opt.unit_price) || 0);
              const optQty = parseInt(opt.quantity) || 1;
              optionsSum += round2(optPrice * optQty);
              return {
                name: opt.name,
                quantity: optQty,
                unit_price: optPrice,
                option_id: opt.option_id ? String(opt.option_id) : undefined
              };
            });
          }

          const basePrice = round2(parseFloat(item.unit_price) || 0);
          const qty = parseInt(item.quantity) || 1;

          const totalPriceItem = round2((basePrice + optionsSum) * qty);
          sumItems += totalPriceItem;

          return {
            name: item.name,
            quantity: qty,
            unit_price: basePrice,
            total_price: totalPriceItem,
            item_id: item.item_id ? String(item.item_id) : undefined,
            observation: item.observation || "",
            options: optionsFormatted.length > 0 ? optionsFormatted : undefined
          };
        });
      }

      const deliveryFee = customer.lastFulfillment === "entrega" ? round2(Number(currentFee)) : 0;
      const totalCalculado = round2(Number(sumItems) + Number(deliveryFee));

      const pmId = parseInt(orderDataFromIA.payment_method_id) || paymentMethodIdPicked || null;

      if (!pmId) {
        await sendText(from, "Só mais uma coisa 😊 qual forma de pagamento você prefere?");
        await askPaymentButtons(from);
        return;
      }

      finalOrderPayload = {
        order_id: txid,
        display_id: String(Date.now()).slice(-6),
        order_type: orderDataFromIA.order_type || (customer.lastFulfillment === "entrega" ? "delivery" : "takeout"),
        observation: orderDataFromIA.observation || "Pedido via WhatsApp",
        customer: {
          phone: toLocalPhone(from),
          name: customer.name || "Cliente WhatsApp"
        },
        totals: {
          order_amount: totalCalculado,
          delivery_fee: deliveryFee,
          additional_fee: 0.0,
          discounts: 0.0
        },
        items: itemsFormatados,
        payments: [
          {
            total: totalCalculado,
            payment_method_id: pmId,
            change_for: orderDataFromIA.change_for ? round2(parseFloat(orderDataFromIA.change_for)) : null
          }
        ]
      };

      if (finalOrderPayload.order_type === "delivery") {
        // exige CEP + coords reais (pra não dar 422 / não quebrar PDV)
        const check = hasValidDeliveryAddressForCW(customer);
        if (!check.ok) {
          const needs = [];
          if (!check.hasCep) needs.push("*CEP* (8 dígitos)");
          if (!check.hasCoords) needs.push("*localização 📍*");
          await sendText(from, `Pra concluir a entrega com segurança, preciso de ${needs.join(" e ")}.\nPode me mandar agora?`);
          return;
        }
        finalOrderPayload.delivery_address = buildDeliveryAddressObjectFromCustomer(customer);
      }

      // SEGURANÇA EXTRA: recalcular totais e garantir pagamento = total
      if (Array.isArray(finalOrderPayload.items)) {
        finalOrderPayload.items = finalOrderPayload.items.map((it) => {
          const fixed = { ...it };
          fixed.total_price = calcItemTotal(fixed);
          return fixed;
        });
      }
      finalOrderPayload.totals.order_amount = calcOrderAmount(finalOrderPayload);
      if (Array.isArray(finalOrderPayload.payments) && finalOrderPayload.payments[0]) {
        finalOrderPayload.payments[0].total = finalOrderPayload.totals.order_amount;
      }
    }

    // ===================================================
    // Se tem payload final: PIX vs Cartão/Dinheiro
    // ===================================================
    if (finalOrderPayload) {
      if (customer.preferredPayment === "pix") {
        const pixData = await createPixCharge(txid, finalOrderPayload.totals.order_amount, customer.name || "Cliente Pappi");

        if (pixData?.pixCopiaECola) {
          const summaryPix = buildOrderSummary(finalOrderPayload.items);
          await Promise.all([
            prisma.order.create({
              data: {
                displayId: txid,
                status: "waiting_payment",
                total: finalOrderPayload.totals.order_amount,
                items: "Aguardando pagamento PIX",
                customerId: customer.id,
                cwJson: JSON.stringify(finalOrderPayload)
              },
            }),
            prisma.customer.update({
              where: { phone: from },
              data: {
                visitCount: { increment: 1 },
                lastOrderSummary: summaryPix || customer.lastOrderSummary,
              }
            }).catch(() => null),
          ]);

          if (resposta) await sendText(from, resposta);

          const qrCodeUrl = `https://quickchart.io/qr?size=300&text=${encodeURIComponent(pixData.pixCopiaECola)}`;
          await sendImage(from, qrCodeUrl, "QR Code PIX ✅");
          await sendText(from, `✅ Para confirmar, faça o PIX e pronto:\n\n*Copia e Cola:*\n${pixData.pixCopiaECola}\n\nAssim que o pagamento cair, o pedido é enviado ao sistema da loja e entra em preparo. 🍕`);

          clearDraft(from);
          pushHistory(from, "assistant", "[PIX GERADO - AGUARDANDO PAGAMENTO PARA ENVIAR À LOJA]");
          return;
        }

        await sendText(from, `Tive um problema ao gerar o QR Code 😅\nPode enviar para a Chave PIX: ${pixKey} e mandar o comprovante?`);
        return;
      }

      // Verifica se ja tem pedido ativo — evita duplicacao na cozinha
      const activeOrder = await prisma.order.findFirst({
        where: { customerId: customer.id, status: { in: ["waiting_confirmation", "confirmed"] } },
        orderBy: { createdAt: "desc" }
      }).catch(() => null);

      if (activeOrder) {
        pendingNewOrder.set(from, { payload: finalOrderPayload, txid });
        await askDuplicateOrderButtons(from, activeOrder.displayId);
        return;
      }

      // Dinheiro ou cartão: cria pedido direto
      try {
        const cwResp = await createOrder(finalOrderPayload);

        const summaryCard = buildOrderSummary(finalOrderPayload.items);
        await Promise.all([
          prisma.order.create({
            data: {
              displayId: txid,
              cwOrderId: cwResp?.id ? String(cwResp.id) : undefined,
              status: String(cwResp?.status || "waiting_confirmation").toLowerCase(),
              total: finalOrderPayload.totals.order_amount,
              items: "Pedido Dinheiro/Cartao",
              customerId: customer.id
            },
          }),
          prisma.customer.update({
            where: { phone: from },
            data: {
              visitCount: { increment: 1 },
              lastOrderSummary: summaryCard || customer.lastOrderSummary,
            }
          }).catch(() => null),
        ]);

        const receipt = buildOrderReceipt({
          payload: finalOrderPayload,
          customer,
          displayId: txid,
          cwDisplayId: cwResp?.display_id || cwResp?.id,
          payList,
        });
        await sendText(from, receipt);
        await sendText(from, ['Aguardando confirmacao da loja.', 'Voce recebera uma atualizacao por aqui assim que confirmarem.'].join(' '));

        clearDraft(from);
        pushHistory(from, "assistant", "[PEDIDO CRIADO NO CARDAPIOWEB - WAITING_CONFIRMATION]");
        return;

      } catch (error) {
        console.error("Falha ao enviar pedido para Cardapio Web:", error?.status, error?.data || error);
        await sendText(from, "Tive um erro ao enviar o pedido pro sistema da loja 😕 Vou chamar um atendente pra confirmar com você agora!");
        await setHandoffOn(from);
        return;
      }
    }

    // Se IA não confirmou ainda, conversa normal
    pushHistory(from, "assistant", resposta);
    await sendText(from, resposta);

  } catch (error) {
    console.error("🔥 Erro Fatal Webhook:", error);
    await sendText(from, `Deu uma instabilidade 😅\nMe diz *tamanho* e *sabor* da pizza? (ou peça aqui: ${LINK_CARDAPIO})`);
  }
});

module.exports = router;
