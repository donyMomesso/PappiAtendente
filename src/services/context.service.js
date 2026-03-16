function getMode({ customer, now = new Date() }) {
  if (!customer) return "BASE";

  const last = customer.lastInteraction ? new Date(customer.lastInteraction) : null;
  const hoursSinceLast = last ? (now - last) / (1000 * 60 * 60) : 999;

  // VIP: voltou em menos de 24h
  if (hoursSinceLast <= 24) return "VIP";

  // EVENT: sexta/sábado
  const day = now.getDay(); // 5=sex, 6=sab
  if (day === 5 || day === 6) return "EVENT";

  return "BASE";
}

module.exports = { getMode };

