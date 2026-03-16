const imported = require("./src/app");

// aceita module.exports = app
// aceita module.exports = { app }
// aceita exports.default = app
const app = imported?.listen ? imported : imported?.app || imported?.default;

if (!app || typeof app.listen !== "function") {
  console.error("❌ ERRO: src/app não exportou um Express app.");
  console.error("Tipo recebido:", typeof imported);
  console.error("Chaves:", imported && typeof imported === "object" ? Object.keys(imported) : null);
  process.exit(1);
}

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🔥 Pappi API rodando na porta", PORT);
});
