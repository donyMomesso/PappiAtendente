// src/services/upsell.service.js

const TOP_PIZZAS = [
  { name: "Costela com Catupiry e Pimenta Biquinho", tag: "Muito elogiada, combinacao irresistivel" },
  { name: "Filadelfia Chicken", tag: "Sucesso absoluto, todo mundo pede" },
  { name: "Carne Seca", tag: "Sabor unico, favorita de quem prova" },
  { name: "Do Pappi", tag: "Calabresa, bacon, champignon, provolone e catupiry — a assinatura da casa" },
  { name: "Moda da Casa", tag: "Favorita da casa, nunca decepciona" },
  { name: "Quatro Queijos", tag: "Classica premium, perfeita com borda" },
  { name: "Lombo com Catupiry", tag: "Macia e saborosa, muito elogiada" },
  { name: "Bacon com Catupiry", tag: "Combinacao que nao tem erro" },
  { name: "Brocolis Especial", tag: "Brocolis, bacon, catupiry e alho frito" },
  { name: "Frango com Catupiry", tag: "Classica e uma das mais pedidas" },
];

const COMBOS_SALGADAS = [
  "1/2 Costela com Catupiry e Pimenta Biquinho + 1/2 Calabresa",
  "1/2 Do Pappi + 1/2 Frango com Catupiry",
  "1/2 Costela com Catupiry e Pimenta Biquinho + 1/2 Frango com Catupiry",
  "1/2 Quatro Queijos + 1/2 Frango com Catupiry",
  "1/2 Moda da Casa + 1/2 Calabresa",
  "1/2 Bacon com Catupiry + 1/2 Calabresa",
  "1/2 Lombo com Catupiry + 1/2 Mussarela",
  "1/2 Filadelfia Chicken + 1/2 Calabresa",
  "1/2 Carne Seca + 1/2 Frango com Catupiry",
  "1/2 Brocolis Especial + 1/2 Mussarela",
];

const COMBOS_DOCES = [
  "1/2 Duo + 1/2 Brigadeiro",
  "1/2 Charge + 1/2 Brigadeiro",
  "1/2 Duo + 1/2 Charge",
  "1/2 Brigadeiro + 1/2 Sensacao",
  "1/2 Duo + 1/2 Sensacao",
];

function getUpsellHint({ historyText = "", userText = "" }) {
  const t = `${historyText}\n${userText}`.toLowerCase();

  // Cliente indeciso ou pedindo sugestao
  const isIndecisive = /nao sei|n sei|nao tenho|que me indica|sugest|indica|nao sab|qualquer|tanto faz|voce escolh/i.test(t);
  if (isIndecisive) {
    return `TOP_PIZZAS`; // sinal para o prompt usar a lista de top pizzas
  }

  // Apos escolher sabor — ancora tamanho
  const choseFlavor = TOP_PIZZAS.some(p => t.includes(p.name.toLowerCase().split(" ")[0]));
  if (choseFlavor && !t.includes("16") && !t.includes("8 ") && !t.includes("fatia")) {
    return `TAMANHO_ANCHOR`; // sinal para sugerir 16 pedacos
  }

  // Meia a meia — sugerir combo popular
  if ((t.includes("meia") || t.includes("meio")) && !t.includes("combo")) {
    return `COMBO_HINT`;
  }

  // Apos tamanho escolhido — sugerir doce ou bebida
  if ((t.includes("16") || t.includes("8 fatia") || t.includes("grande")) && !t.includes("doce") && !t.includes("coca") && !t.includes("refri")) {
    return `DOCE_UPSELL`;
  }

  // Calabresa — borda
  if (t.includes("calabresa") && !t.includes("borda")) {
    return "Essa combina demais com borda recheada. Quer adicionar?";
  }

  // Pizza grande — bebida
  if ((t.includes("16") || t.includes("gigante")) && !t.includes("coca") && !t.includes("refri")) {
    return "Quer aproveitar e adicionar uma Coca 2L?";
  }

  return null;
}

module.exports = { getUpsellHint, TOP_PIZZAS, COMBOS_SALGADAS, COMBOS_DOCES };
