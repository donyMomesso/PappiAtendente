const fetch = require("node-fetch");

const apiKey = process.env.GEMINI_API_KEY || "";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

let cachedModel = null;

async function listModels() {
  const resp = await fetch(`${API_BASE}/models`, {
    headers: { "x-goog-api-key": apiKey },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ListModels failed: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  return data.models || [];
}

function pickBestModel(models) {
  // pega os que suportam generateContent
  const supported = models.filter((m) =>
    (m.supportedGenerationMethods || []).includes("generateContent")
  );

  // prioridade (se existir na sua conta)
  const preferred = [
    process.env.GEMINI_MODEL,        // se você setar no Render
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
  ].filter(Boolean);

  for (const name of preferred) {
    const found = supported.find((m) => m.name === `models/${name}` || m.name === name);
    if (found) return found.name.startsWith("models/") ? found.name : `models/${found.name}`;
  }

  // fallback: primeiro disponível
  if (supported[0]) return supported[0].name;

  return null;
}

async function ensureModel() {
  if (cachedModel) return cachedModel;
  if (!apiKey) throw new Error("Chave GEMINI_API_KEY ausente no Render.");

  const models = await listModels();
  const picked = pickBestModel(models);

  if (!picked) {
    throw new Error("Nenhum modelo com generateContent disponível para essa chave (ListModels vazio/sem suporte).");
  }

  cachedModel = picked; // ex: "models/gemini-2.5-flash"
  console.log("🤖 Modelo Gemini selecionado:", cachedModel);
  return cachedModel;
}

async function generateContent(modelFullName, prompt) {
  const url = `${API_BASE}/${modelFullName}:generateContent`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`generateContent failed: ${resp.status} ${JSON.stringify(data)}`);
  }

  // padrão: candidates[0].content.parts[0].text
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || null;

  return text;
}

async function chatCompletion(messagesArray) {
  if (!apiKey) throw new Error("Chave GEMINI_API_KEY ausente no Render.");

  let fullPrompt = "";

  messagesArray.forEach((msg) => {
    if (msg.role === "system") fullPrompt += `INSTRUÇÕES:\n${msg.content}\n\n---\n\n`;
    if (msg.role === "user") fullPrompt += `Cliente: ${msg.content}\n`;
    if (msg.role === "assistant") fullPrompt += `Atendente: ${msg.content}\n`;
  });

  fullPrompt += "Atendente:";

  try {
    const model = await ensureModel();
    return await generateContent(model, fullPrompt);
  } catch (err) {
    console.error("🔥 Erro no Brain:", err.message);
    return null; // não derruba a API
  }
}

module.exports = { chatCompletion };
