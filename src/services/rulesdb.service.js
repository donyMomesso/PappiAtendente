const { loadRulesFromFiles } = require("../rules/loader");

async function loadRules({ prisma, mode }) {
  // Opcional: guardar no banco como:
  // key: RULES_BASE, RULES_VIP, RULES_EVENT, RULES_PROMO
  // Se não existir, cai nos arquivos.
  try {
    const key = `RULES_${mode || "BASE"}`; // RULES_BASE / RULES_VIP / RULES_EVENT
    const row = await prisma.config.findUnique({ where: { key } }).catch(() => null);
    if (row?.value) return row.value;
  } catch {}

  return loadRulesFromFiles(mode);
}

async function saveRules({ prisma, mode, text }) {
  const key = `RULES_${mode || "BASE"}`;
  return prisma.config.upsert({
    where: { key },
    update: { value: text },
    create: { key, value: text },
  });
}

module.exports = { loadRules, saveRules };
