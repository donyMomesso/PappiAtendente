const fs = require("fs");
const path = require("path");

function read(name) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8");
}

function loadRulesFromFiles(mode) {
  const base = read("base.md");
  const promo = read("promo.md");
  const vip = read("vip.md");
  const event = read("event.md");

  if (mode === "VIP") return [base, promo, vip].filter(Boolean).join("\n\n");
  if (mode === "EVENT") return [base, promo, event].filter(Boolean).join("\n\n");
  return [base, promo].filter(Boolean).join("\n\n");
}

module.exports = { loadRulesFromFiles };

