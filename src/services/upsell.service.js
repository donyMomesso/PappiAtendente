function getUpsellHint({ historyText = "", userText = "" }) {
  const t = `${historyText}\n${userText}`.toLowerCase();

  if (t.includes("16") || t.includes("gigante")) {
    return "Quer aproveitar e adicionar uma Coca 2L geladinha por um valor especial? 🥤";
  }
  if (t.includes("calabresa")) {
    return "Essa combina demais com borda recheada 😋 Quer adicionar?";
  }
  if (t.includes("frango") && t.includes("catupiry")) {
    return "Quer adicionar uma porçãozinha pra acompanhar? Fica top 😋";
  }
  return null;
}

module.exports = { getUpsellHint };
