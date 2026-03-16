const crypto = require("crypto");

/**
 * Perfil por sinais (sem “adivinhar” DISC).
 * A gente guarda:
 * - tags: rótulos simples (preco_sensivel, ticket_alto, indeciso, objetivo, familia...)
 * - scores: 0-100 (ticket, rapidez, indecisao)
 * Tudo pode ser usado depois em campanhas.
 */

function anonId(phone) {
  const salt = process.env.ANON_SALT || "pappi";
  return crypto
    .createHash("sha256")
    .update(String(phone || "") + salt)
    .digest("hex")
    .slice(0, 10);
}

function safeJsonParse(str, fallback) {
  try {
    if (!str) return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function addTag(tags, t) {
  if (!t) return;
  if (!tags.includes(t)) tags.push(t);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function detectSignalsFromText(text) {
  const t = String(text || "").toLowerCase();

  const signals = {
    wantsPromo: /promo|promoc|cupom|desconto|barat|preço|valor/i.test(t),
    wantsFast: /rápido|logo|urgente|correndo|agora|to com pressa/i.test(t),
    indecisive: /qual sabor|quais sabor|cardápio|menu|o que tem|me indica|sugere/i.test(t),
    family: /fam[ií]lia|crianç|kids|2 pizza|duas pizza|3 pizza|galera/i.test(t),
    addOns: /refri|refrigerante|coca|guaran|suco|sobremesa|doce|borda|catupiry|cheddar|batata|combo/i.test(t),
    bigSize: /\b16\b|gigante|familia|família|grande\b|\b8\b/i.test(t),
  };

  return signals;
}

/**
 * Atualiza perfil a partir da conversa.
 * historyText pode ser o histórico curto (últimas 10 falas).
 */
function buildProfileUpdate({ phone, userText, historyText, currentProfile, currentTags }) {
  const tags = Array.isArray(currentTags) ? [...currentTags] : [];
  const profile = typeof currentProfile === "object" && currentProfile ? { ...currentProfile } : {};

  // scores base
  profile.score_ticket = Number.isFinite(profile.score_ticket) ? profile.score_ticket : 50;
  profile.score_speed = Number.isFinite(profile.score_speed) ? profile.score_speed : 50;
  profile.score_indecisao = Number.isFinite(profile.score_indecisao) ? profile.score_indecisao : 50;

  const sig = detectSignalsFromText(userText);
  const sigH = detectSignalsFromText(historyText);

  // -------- TAGS --------
  if (sig.wantsPromo || sigH.wantsPromo) addTag(tags, "preco_sensivel");
  if (sig.indecisive || sigH.indecisive) addTag(tags, "indeciso");
  if (sig.family || sigH.family) addTag(tags, "familia");
  if (sig.addOns || sigH.addOns) addTag(tags, "aberto_a_adicionais");
  if (sig.bigSize || sigH.bigSize) addTag(tags, "tamanho_grande");

  // -------- SCORES --------
  // Ticket: cresce com adicionais + tamanho
  if (sig.addOns) profile.score_ticket += 10;
  if (sig.bigSize) profile.score_ticket += 10;
  if (sig.family) profile.score_ticket += 8;
  if (sig.wantsPromo) profile.score_ticket -= 5; // sensível a preço pode reduzir ticket

  // Rapidez: cresce com “agora/rápido”
  if (sig.wantsFast) profile.score_speed += 12;
  if (sig.indecisive) profile.score_speed -= 6;

  // Indecisão: cresce quando pede cardápio/sugestão
  if (sig.indecisive) profile.score_indecisao += 12;
  if (sig.wantsFast) profile.score_indecisao -= 6;

  // clamp 0..100
  profile.score_ticket = clamp(profile.score_ticket, 0, 100);
  profile.score_speed = clamp(profile.score_speed, 0, 100);
  profile.score_indecisao = clamp(profile.score_indecisao, 0, 100);

  // id anônimo (pra usar em painel/campanhas sem expor telefone)
  profile.anon_id = profile.anon_id || anonId(phone);

  // segmento simples (opcional)
  profile.segment =
    profile.score_ticket >= 70 ? "ticket_alto"
    : profile.score_indecisao >= 70 ? "indeciso"
    : profile.score_speed >= 70 ? "rapido_objetivo"
    : "neutro";

  // tag de ticket alto
  if (profile.segment === "ticket_alto") addTag(tags, "ticket_alto");
  if (profile.segment === "rapido_objetivo") addTag(tags, "objetivo");

  return { tags, profile };
}

module.exports = {
  safeJsonParse,
  buildProfileUpdate,
};
