const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const { TavilyClient } = require("tavily");
const tavily = new TavilyClient({
  apiKey: process.env.TAVILY_API_KEY
});
const ChatSession = require("./models/ChatSession");
const ChatMessage = require("./models/ChatMessage");
const User = require("./models/User");
const DocumentMeta = require("./models/DocumentMeta");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { Document } = require("docx");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fal } = require("@fal-ai/client");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

dotenv.config();

fal.config({
  credentials: process.env.FAL_KEY,
});

async function getEmbedding(text) {
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "BAAI/bge-m3",
      input: text
    })
  });

  const data = await response.json();

  console.log("🔍 EMBEDDING RESPONSE:", data);

  if (!data || !data.data || !data.data[0]) {
    throw new Error("Embedding API zwróciło błąd: " + JSON.stringify(data));
  }

  return data.data[0].embedding;
}

// ===============================
// MongoDB
// ===============================
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Połączono z MongoDB"))
  .catch(err => console.error("Błąd połączenia z MongoDB:", err));

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ===============================
// Folder na zdjęcia (Render filesystem)
// ===============================
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

// statyczne serwowanie plików
app.use("/uploads", express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

const groq = new Groq({ apiKey: process.env.API_KEY });

const SYSTEM_PROMPT = `
Jesteś asystentem o nazwie Serivio.

Zasady:
- Odpowiadasz zawsze w języku użytkownika (automatycznie wykrywasz język).
- Jeśli w wiadomości znajduje się obraz (image_url), możesz go analizować i odnosić się do jego treści. Jeśli obraz nie został dostarczony w tej wiadomości, nie zakładaj, że masz do niego dostęp.
- Jeśli pytanie wymaga aktualnych danych (np. polityka, daty, wydarzenia, fakty po 2023), możesz korzystać z wyników wyszukiwania internetowego.
- Jeśli nie masz danych — mówisz "Nie wiem" lub "Nie mam dostępu do aktualnych danych".
- Nie powtarzasz zachęt typu "zadaj pytanie".
- Odpowiadasz konkretnie i bez lania wody.
- Nie mieszasz języków — trzymasz się języka użytkownika.
- Jeśli pytanie jest niejasne — prosisz o doprecyzowanie.
- Nie wymyślasz faktów.
`;
//=====================================
// wykrywanie intencji generowania
//=====================================
async function detectImageIntent(message) {
  const completion = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      {
        role: "system",
        content: `
Odpowiadasz TYLKO słowem TAK lub NIE.

Odpowiedz TAK, jeśli użytkownik:
- chce wygenerować obraz,
- chce stworzyć grafikę,
- chce narysować coś,
- chce stworzyć scenę,
- chce wygenerować zdjęcie,
- prosi o stworzenie wizualizacji,
- używa słów: "wygeneruj obraz", "stwórz obraz", "zrób obraz", "zrób grafikę",
  "generate image", "make a picture", "draw", "create image".

Odpowiedz NIE, jeśli użytkownik:
- prosi tylko o opis,
- komentuje zdjęcie,
- zadaje pytanie,
- nie prosi o stworzenie nowego obrazu.

Odpowiadasz jednym słowem: TAK lub NIE.
`
      },
      {
        role: "user",
        content: message
      }
    ],
    max_tokens: 5,
    temperature: 0
  });

  const reply = (completion.choices[0].message.content || "").trim().toLowerCase();
  return reply.includes("tak");
}

// ===============================
// KREDYTY + LIMITY – FUNKCJA
// ===============================
async function ensureUser(uid) {
  let user = await User.findById(uid);

  if (!user) {
    user = await User.create({
      _id: uid,
      credits: 0,
      limitGenerateUsed: 0,
      limitPhotoUsed: 0,
      limitDocumentsUsed: 0,
      lastLimitsReset: new Date()
    });
  }

  const today = new Date().toDateString();
  const last = user.lastLimitsReset?.toDateString();

  if (today !== last) {
    user.limitGenerateUsed = 0;
    user.limitPhotoUsed = 0;
    user.limitDocumentsUsed = 0;
    user.lastLimitsReset = new Date();
    await user.save();
  }

  return user;
}

// ===============================
// POST /chat — czat tekstowy (z Tavily + system prompt)
// ===============================
app.post("/chat", async (req, res) => {
  try {
    const { userId, message, chatId } = req.body;

    if (!userId) return res.status(400).json({ error: "Brak userId" });
    if (!message || message.trim() === "")
      return res.status(400).json({ error: "Brak wiadomości" });

    let currentChatId = chatId;

    if (!currentChatId) {
      currentChatId = Date.now().toString();

      await ChatSession.create({
        chatId: currentChatId,
        userId,
        title: message.slice(0, 40),
        lastUsedAt: new Date()
      });
    } else {
      await ChatSession.updateOne(
        { chatId: currentChatId },
        { lastUsedAt: new Date() }
      );
    }

    await ChatMessage.create({
      chatId: currentChatId,
      role: "user",
      content: message,
      type: "text"
    });

// =============================================
// GENEROWANIE OBRAZU Z TŁUMACZENIEM NA ANGIELSKI
// =============================================
const wantsImage = await detectImageIntent(message);

if (wantsImage) {
  
  // 1. Podstawowe czyszczenie polskiego tekstu
  let rawPrompt = message
    .replace(/wygeneruj mi|proszę|zrób|stwórz|obraz|zdjęcie|grafikę/gi, "")
    .replace(/ma być|styl ma być|jak w|w stylu/gi, "")
    .trim();

  // 2. Tłumaczenie + optymalizacja promptu (to jest klucz!)
  const translation = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",     // najlepszy model do tego zadania
    messages: [
      {
        role: "system",
        content: `Jesteś ekspertem od tworzenia promptów do Flux AI.
Przetłumacz opis użytkownika na bardzo dobry, szczegółowy, naturalny angielski prompt.
Skup się na obiekcie, kompozycji, stylu, oświetleniu, nastroju i jakości.
Używaj artystycznych terminów.
Wyjście: TYLKO czysty angielski prompt, bez żadnych dodatkowych słów.`
      },
      {
        role: "user",
        content: rawPrompt || message
      }
    ],
    temperature: 0.3,
    max_tokens: 280
  });

  let finalPrompt = translation.choices[0].message.content.trim();

  // 3. Ostateczne czyszczenie
  finalPrompt = finalPrompt
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  console.log("🇵🇱 Oryginalny prompt:", message);
  console.log("🇬🇧 Final prompt dla Flux:", finalPrompt);

  // 4. Generowanie obrazu
  const falResult = await fal.run("fal-ai/flux-pro", {
    input: {
      prompt: finalPrompt,
      image_size: "square_hd",
      num_images: 1,
      guidance_scale: 3.5,      // lepiej trzyma się promptu
      num_inference_steps: 28
    }
  });

  const imageUrl = 
    falResult?.data?.images?.[0]?.url ||
    falResult?.images?.[0]?.url ||
    falResult?.output?.images?.[0]?.url;

  if (!imageUrl) {
    console.error("❌ Nie znaleziono URL obrazu");
    return res.status(500).json({ error: "Nie udało się wygenerować obrazu" });
  }

  await ChatMessage.create({
    chatId: currentChatId,
    role: "assistant",
    type: "image",
    content: "[GENERATED_IMAGE]",
    imageUrl
  });

  return res.json({
    type: "image",
    imageUrl,
    reply: null,
    chatId: currentChatId
  });
}

    // LIMITUJEMY LICZBĘ WIADOMOŚCI DO 50
const userCount = await ChatMessage.countDocuments({ chatId: currentChatId });
if (userCount > 50) {
  await ChatMessage.findOneAndDelete(
    { chatId: currentChatId },
    { sort: { createdAt: 1 } } // usuń NAJSTARSZĄ
  );
}

    const history = await ChatMessage.find({ chatId: currentChatId })
  .sort({ createdAt: 1 })
  .limit(50);

    const DocumentChunk = require("./models/DocumentChunk");

// 1. Sprawdź, czy w historii jest dokument — bierzemy ostatni
const docMsg = history.filter(m => m.type === "document").pop();

let documentContext = "";
if (docMsg) {
  const documentId = docMsg.content.replace("DOCUMENT_ID:", "");

  // 2. Embedding pytania
  const qEmbed = await getEmbedding(message);

  // 3. Pobierz wszystkie chunki dokumentu
  const chunks = await DocumentChunk.find({ documentId });

  // 4. Policz podobieństwo
  function cosine(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  const ranked = chunks
    .map(c => ({
      text: c.text,
      score: cosine(qEmbed, c.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  documentContext = ranked.map(r => r.text).join("\n\n---\n\n");
}

// ostatnie 10 wiadomości tekstowych
const textHistory = history
  .filter(
    m =>
      m.type === "text" &&
      m.content &&
      m.content.trim() !== "" &&
      m.content !== "[EMPTY_REPLY]"
  )
  .slice(-10);

// ostatnie 5 wiadomości związanych z obrazem
const imageHistory = history
  .filter(m => m.type === "image" || m.type === "image_description")
  .slice(-2);

// łączymy obie listy i sortujemy po czasie
const trimmedHistory = [...textHistory, ...imageHistory].sort(
  (a, b) => a.createdAt - b.createdAt
);

    // Czy pytanie wymaga internetu?
    const needsSearch = /kto|kiedy|ile|data|rok|prezydent|premier|pogoda|wynik|co się stało|news|aktualne/i.test(
      message
    );

    let searchResults = "";
    if (needsSearch) {
      try {
        const tavilyResponse = await tavily.search(message, { max_results: 5 });
        searchResults = tavilyResponse.results
          .map(r => `• ${r.title}: ${r.url}`)
          .join("\n");
      } catch (e) {
        console.error("Tavily error:", e);
        searchResults = "Brak wyników wyszukiwania.";
      }
    }

    const messagesForModel = [
  { role: "system", content: SYSTEM_PROMPT },
];

// jeśli jest dokument → dodaj kontekst
if (documentContext) {
  messagesForModel.push({
    role: "system",
    content: `Oto fragmenty dokumentu powiązane z pytaniem:\n${documentContext}`
  });
}

// dodaj historię rozmowy
messagesForModel.push(
  ...trimmedHistory
    .map(m => {
      // 🔥 jeśli to obraz — sprawdź, czy plik istnieje
      if (m.type === "image") {
        const filePath = path.join(__dirname, "uploads", path.basename(m.imageUrl));

        // jeśli plik NIE istnieje → pomiń tę wiadomość
        if (!fs.existsSync(filePath)) {
          return null;
        }

        // jeśli istnieje → wyślij do modelu
        return {
          role: "user",
          content: [
            { type: "text", text: m.content || "Użytkownik wysłał obraz." },
            { type: "image_url", image_url: { url: m.imageUrl } }
          ]
        };
      }

      // opisy obrazów
      if (m.type === "image_description") {
        return {
          role: "system",
          content: `Opis obrazu: ${m.imageDescription || m.content}`
        };
      }

      // normalne wiadomości
      return {
        role: m.role,
        content: m.content
      };
    })
    .filter(Boolean) // usuń null (martwe obrazy)
);

// dodaj wyniki wyszukiwania
if (searchResults) {
  messagesForModel.push({
    role: "system",
    content: `Wyniki wyszukiwania internetowego:\n${searchResults}`
  });
}

    const completion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: messagesForModel,
      max_tokens: 300,
      temperature: 0.4
    });

    const reply = (completion.choices[0].message.content || "").trim();

    console.log("RAW MODEL RESPONSE:", JSON.stringify(completion, null, 2));
console.log("EXTRACTED reply:", reply);

    // jeśli model zwróci pustą odpowiedź – NIE zapisujemy jej do historii
if (!reply) {
  return res.json({
    reply: "Przepraszam, nie zrozumiałem. Możesz powtórzyć?",
    chatId: currentChatId
  });
}

    await ChatMessage.create({
  chatId: currentChatId,
  role: "assistant",
  content: reply,
  type: "text"
});

    // LIMITUJEMY LICZBĘ WIADOMOŚCI DO 50
const count = await ChatMessage.countDocuments({ chatId: currentChatId });
if (count > 50) {
  await ChatMessage.findOneAndDelete(
    { chatId: currentChatId },
    { sort: { createdAt: 1 } } // usuń NAJSTARSZĄ
  );
}

    res.json({ reply, chatId: currentChatId });

  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ===============================
// GET /history
// ===============================
app.get("/history", async (req, res) => {
  const chatId = req.query.chatId;
  if (!chatId) return res.status(400).json({ error: "Brak chatId" });

  const history = await ChatMessage.find({ chatId }).sort({ createdAt: 1 });
  res.json({ history });
});


// ===============================
// GET /chats
// ===============================
app.get("/chats", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "Brak userId" });

  const sessions = await ChatSession.find({ userId }).sort({ lastUsedAt: -1 });

  res.json(
    sessions.map(s => ({
      chatId: s.chatId,
      title: s.title,
      lastUsedAt: s.lastUsedAt
    }))
  );
});


// ===============================
// POST /reset
// ===============================
app.post("/reset", async (req, res) => {
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ error: "Brak userId" });

  await ChatSession.deleteMany({ userId });
  await ChatMessage.deleteMany({ userId });

  res.json({ status: "reset" });
});


// ===============================
// POST /deleteChat
// ===============================
app.post("/deleteChat", async (req, res) => {
  const { userId, chatId } = req.body;

  if (!userId) return res.status(400).json({ error: "Brak userId" });
  if (!chatId) return res.status(400).json({ error: "Brak chatId" });

  try {
    await ChatSession.deleteOne({ userId, chatId });
    await ChatMessage.deleteMany({ chatId });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Delete chat error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});


// ===============================
// POST /upload — Vision (URL, nie base64)
// ===============================
app.post("/upload", upload.single("file"), async (req, res) => {
  let filePath;
  try {
    const { userId, chatId, message } = req.body;

    if (!userId) return res.status(400).json({ error: "Brak userId" });
    if (!req.file) return res.status(400).json({ error: "Brak pliku!" });

    let currentChatId = chatId;

    if (!currentChatId) {
      currentChatId = Date.now().toString();

      await ChatSession.create({
        chatId: currentChatId,
        userId,
        title: "Rozmowa ze zdjęciem",
        lastUsedAt: new Date()
      });
    } else {
      await ChatSession.updateOne(
        { chatId: currentChatId },
        { lastUsedAt: new Date() }
      );
    }

    // zapis pliku na serwerze (Render)
    const fileName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.jpg`;
    filePath = path.join(UPLOAD_DIR, fileName);
    fs.writeFileSync(filePath, req.file.buffer);

    const imageUrl = `https://serivio-backend.onrender.com/uploads/${fileName}`;

    await ChatMessage.create({
      chatId: currentChatId,
      role: "user",
      type: "image",
      content: message?.trim() ? message : "[IMAGE]",
      imageUrl
    });

    const promptText = message?.trim()
      ? `Użytkownik napisał: "${message}". Najpierw opisz zdjęcie szczegółowo w jezyku urzytkownika, potem odpowiedz na pytanie lub komentarz.`
      : "Użytkownik wysłał zdjęcie bez tekstu. Opisz bardzo szczegółowo wszystko, co widzisz na zdjęciu w jezyku urzytkownika (kolory, obiekty, tekst, scena, emocje itp.).";

    const completion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            {
              type: "image_url",
              image_url: { url: imageUrl }
            }
          ]
        }
      ],
      max_tokens: 300,
      temperature: 0.4
    });

    const reply = (completion.choices[0].message.content || "").trim();

if (!reply) {
  return res.json({
    reply: "Przepraszam, nie udało mi się nic sensownego odczytać z tego zdjęcia. Możesz spróbować inaczej to opisać?",
    chatId: currentChatId
  });
}

await ChatMessage.create({
  chatId: currentChatId,
  role: "assistant",
  type: "text",
  content: reply
});

await ChatMessage.create({
  chatId: currentChatId,
  role: "system",
  type: "image_description",
  content: "[IMAGE_DESCRIPTION]",
  imageDescription: reply
});

res.json({ reply, chatId: currentChatId });

  } catch (err) {
    console.error("❌ Błąd uploadu:", err);
    res.status(500).json({ error: "Błąd serwera podczas uploadu" });
  } finally {
    // sprzątanie pliku po chwili (żeby Groq zdążył pobrać)
    if (filePath && fs.existsSync(filePath)) {
      setTimeout(() => {
        try {
          fs.unlinkSync(filePath);
          console.log("Usunięto plik:", filePath);
        } catch (e) {
          console.warn("Nie udało się usunąć pliku:", e);
        }
      }, 15000);
    }
  }
});


// ===============================
// POST /upload-document — dokumenty
// ===============================
const DocumentChunk = require("./models/DocumentChunk");

app.post("/upload-document", upload.single("file"), async (req, res) => {
  try {
    const { userId, chatId } = req.body;

    if (!userId) return res.status(400).json({ error: "Brak userId" });
    if (!req.file) return res.status(400).json({ error: "Brak pliku!" });

    let currentChatId = chatId;

    if (!currentChatId) {
      currentChatId = Date.now().toString();

      await ChatSession.create({
        chatId: currentChatId,
        userId,
        title: "Dokument",
        lastUsedAt: new Date()
      });
    } else {
      await ChatSession.updateOne(
        { chatId: currentChatId },
        { lastUsedAt: new Date() }
      );
    }

        const documentId = crypto.randomUUID();

    await DocumentMeta.create({
      documentId,
      userId,
      chatId: currentChatId,
      originalName: req.file.originalname,
      status: "processing"
    });

    await ChatMessage.create({
      chatId: currentChatId,
      role: "system",
      type: "document",
      content: `DOCUMENT_ID:${documentId}`
    });

    // OD RAZU odpowiedź
    res.json({
      reply: "Dokument został przyjęty. Trwa analizowanie pliku...",
      chatId: currentChatId,
      documentId
    });

    // Przetwarzanie w tle
    processDocumentInBackground({
      documentId,
      userId,
      chatId: currentChatId,
      file: req.file
    }).catch(err => {
      console.error("❌ Błąd przetwarzania dokumentu:", err);
      DocumentMeta.updateOne(
        { documentId },
        { $set: { status: "error" } }
      );
    });

  } catch (err) {
    console.error("❌ Błąd dokumentu:", err);
    res.status(500).json({ error: "Błąd serwera podczas analizy dokumentu" });
  }
});

// ===============================
// Przetwarzanie dokumentu w tle (asynchroniczne, szybkie)
// ===============================
async function processDocumentInBackground({ documentId, userId, chatId, file }) {
  console.log("▶️ Start przetwarzania dokumentu:", documentId);

  // 1. Ekstrakcja tekstu
  const text = await extractTextFromDocument(file);

  // 2. Chunkowanie (większe chunki = mniej embeddingów)
  const chunkSize = 20000;
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

  // 3. Równoległe embeddingi
  const embeddings = await Promise.all(
    chunks.map(c => getEmbedding(c))
  );

  // 4. Zapis hurtowy
  await DocumentChunk.insertMany(
    chunks.map((c, i) => ({
      chatId,
      userId,
      documentId,
      chunkIndex: i,
      text: c,
      embedding: embeddings[i]
    }))
  );

  // 5. Oznacz dokument jako gotowy
  await DocumentMeta.updateOne(
    { documentId },
    { $set: { status: "ready", updatedAt: new Date() } }
  );

  console.log("✅ Dokument przetworzony:", documentId);
}

// ===============================
// Ekstrakcja tekstu z dokumentów
// ===============================
async function extractTextFromDocument(file) {
  const name = file.originalname.toLowerCase();

  if (name.endsWith(".pdf")) return await extractFromPdf(file);
  if (name.endsWith(".docx")) return await extractFromDocx(file);
  if (name.endsWith(".txt")) return extractFromTxt(file);

  return "Nieobsługiwany format pliku.";
}

async function extractFromPdf(file) {
  const data = await pdfParse(file.buffer);
  return data.text || "Brak tekstu w PDF.";
}

async function extractFromDocx(file) {
  const doc = await Document.load(file.buffer);
  return doc.getText() || "Brak tekstu w DOCX.";
}

function extractFromTxt(file) {
  return file.buffer.toString("utf8");
}

// ===============================
// STATUS DOKUMENTU
// ===============================
app.get("/document-status/:documentId", async (req, res) => {
  const { documentId } = req.params;

  const meta = await DocumentMeta.findOne({ documentId });

  if (!meta) {
    return res.status(404).json({ status: "not_found" });
  }

  res.json({ status: meta.status });
});

// ===============================
// POST /generate-image — proste generowanie obrazu
// ===============================
app.post("/generate-image", async (req, res) => {
  try {
    let { prompt } = req.body;

    if (!prompt || prompt.trim() === "") {
      return res.status(400).json({ error: "Brak promptu" });
    }

    const cleanPrompt = prompt
      .replace(/[\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    console.log("🧹 Clean prompt:", cleanPrompt.substring(0, 250) + "...");

    const falResult = await fal.run("fal-ai/flux-pro", {
      input: {
        prompt: cleanPrompt,
        image_size: "square_hd",
        num_images: 1,
      }
    });

    console.log("✅ FAL RESULT:", JSON.stringify(falResult, null, 2));

    const imageUrl =
      falResult?.data?.images?.[0]?.url ||
      falResult?.images?.[0]?.url ||
      falResult?.output?.images?.[0]?.url ||
      falResult?.output?.image ||
      falResult?.image;

    if (!imageUrl) {
      console.error("❌ fal.ai nie zwróciło URL:", falResult);
      return res.status(500).json({ error: "fal.ai nie zwróciło obrazu" });
    }

    return res.json({
      imageUrl,
      prompt: cleanPrompt
    });

  } catch (err) {
    console.error("❌ Błąd generowania obrazu:", err?.response?.body || err);
    res.status(500).json({
      error: "Błąd generowania obrazu",
      details: err?.response?.body?.detail || err.message
    });
  }
});

app.post("/chat-image", upload.single("file"), async (req, res) => {
  try {
    const { userId, chatId, message } = req.body;
    const file = req.file;

    if (!userId) return res.status(400).json({ error: "Brak userId" });
    if (!file) return res.status(400).json({ error: "Brak pliku!" });

    let currentChatId = chatId;
    if (!currentChatId) {
      currentChatId = Date.now().toString();
      await ChatSession.create({
        chatId: currentChatId,
        userId,
        title: message?.slice(0, 40) || "Rozmowa ze zdjęciem",
        lastUsedAt: new Date()
      });
    } else {
      await ChatSession.updateOne(
        { chatId: currentChatId },
        { lastUsedAt: new Date() }
      );
    }

    const fileName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.jpg`;
    const filePath = path.join(UPLOAD_DIR, fileName);
    fs.writeFileSync(filePath, file.buffer);

    const backendUrl = process.env.BACKEND_URL || "https://serivio-backend.onrender.com";
    const imageUrl = `${backendUrl}/uploads/${fileName}`;

    await ChatMessage.create({
      chatId: currentChatId,
      role: "user",
      type: "image",
      content: message?.trim() ? message : "[IMAGE]",
      imageUrl
    });

    const visionPrompt = message?.trim()
      ? `Najpierw bardzo szczegółowo opisz scenę na zdjęciu, potem potraktuj to jako kontekst do polecenia użytkownika: "${message}".`
      : "Opisz bardzo szczegółowo wszystko, co widzisz na zdjęciu (scena, obiekty, światło, perspektywa).";

    const visionCompletion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: visionPrompt },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ],
      max_tokens: 300,
      temperature: 0.4
    });

    const sceneDescription = (visionCompletion.choices[0].message.content || "").trim();

    const wantsImage = await detectImageIntent(message || "");

    if (!wantsImage) {
      await ChatMessage.create({
        chatId: currentChatId,
        role: "assistant",
        type: "text",
        content: sceneDescription
      });

      return res.json({
        type: "text",
        reply: sceneDescription || "Nie udało się opisać zdjęcia.",
        chatId: currentChatId
      });
    }

    // ==================== GENEROWANIE OBRAZU NA PODSTAWIE ZDJĘCIA ====================
    const imagePrompt = `
Oryginalne zdjęcie pokazuje następującą scenę:
${sceneDescription}

Polecenie użytkownika: "${message || ""}"

Zadanie:
Użyj oryginalnego zdjęcia jako bazy. Stwórz NOWY obraz, który jest modyfikacją lub kontynuacją tej sceny.
Dokładnie uwzględnij polecenie użytkownika (np. dodaj kota na stole, zamień obiekt na psa, zmień tło itp.).
Zachowaj oświetlenie, perspektywę, kolorystykę i klimat oryginalnego zdjęcia tak bardzo jak to możliwe.
Styl ma być spójny z oryginalnym zdjęciem.

Wygeneruj wysokiej jakości, szczegółowy obraz.
`.trim();

    // Mocne czyszczenie promptu
    const cleanImagePrompt = imagePrompt
      .replace(/[\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    console.log("🖼️ Prompt image-to-image:", cleanImagePrompt.substring(0, 300) + "...");

    const falResult = await fal.run("fal-ai/flux-pro", {
      input: {
        prompt: cleanImagePrompt,
        image_size: "square_hd",
        num_images: 1,
        guidance_scale: 3.5,
        num_inference_steps: 30
      }
    });

    const generatedImageUrl =
      falResult?.data?.images?.[0]?.url ||
      falResult?.images?.[0]?.url ||
      falResult?.output?.images?.[0]?.url;

    if (!generatedImageUrl) {
      console.error("❌ fal.ai nie zwróciło obrazu:", falResult);
      return res.status(500).json({ error: "Nie udało się wygenerować obrazu" });
    }

    await ChatMessage.create({
      chatId: currentChatId,
      role: "assistant",
      type: "image",
      content: "[GENERATED_IMAGE]",
      imageUrl: generatedImageUrl
    });

    return res.json({
      type: "image",
      imageUrl: generatedImageUrl,
      chatId: currentChatId
    });

  } catch (err) {
    console.error("❌ Błąd /chat-image:", err?.response?.body || err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ===============================
// AdMob — callback nagrody (SSV)
// ===============================
app.get("/admob/reward-callback", async (req, res) => {
  try {
    const { user_id, reward_amount } = req.query;

    console.log("AdMob callback query:", req.query);

    if (!user_id) return res.status(400).send("missing user_id");

    // UWAGA: Musisz mieć model User z polem credits
    let user = await User.findById(user_id);
if (!user) {
  user = await User.create({ _id: user_id, credits: 0 });
}

    const amount = parseInt(reward_amount || "1", 10);
    user.credits = (user.credits || 0) + amount;
    await user.save();

    return res.status(200).send("ok");
  } catch (err) {
    console.error("❌ AdMob callback error:", err);
    return res.status(500).send("error");
  }
});

// ===============================
// GET /user/:id — pobieranie kredytów
// ===============================
app.get("/user/:id", async (req, res) => {
  try {
    const { id } = req.params;

    let user = await User.findById(id);

    if (!user) {
      user = await User.create({ _id: id, credits: 0 });
    }

    res.json({ credits: user.credits });
  } catch (err) {
    console.error("❌ User error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ===============================
// KREDYTY – POBIERANIE
// ===============================
app.post("/credits/get", async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: "Brak uid" });

    const user = await ensureUser(uid);

    res.json({
      credits: user.credits,
      limitGenerateUsed: user.limitGenerateUsed,
      limitPhotoUsed: user.limitPhotoUsed,
      limitDocumentsUsed: user.limitDocumentsUsed
    });
  } catch (err) {
    console.error("❌ credits/get error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ===============================
// KREDYTY – UŻYCIE FUNKCJI PREMIUM
// ===============================
app.post("/credits/use", async (req, res) => {
  try {
    const { uid, type } = req.body;

    if (!uid) return res.status(400).json({ error: "Brak uid" });
    if (!type) return res.status(400).json({ error: "Brak type" });

    const user = await ensureUser(uid);

    let cost = 0;
    let limitField = "";
    let limitMax = 0;

    if (type === "generate") {
      cost = 25;
      limitField = "limitGenerateUsed";
      limitMax = 2;
    } else if (type === "photo") {
      cost = 10;
      limitField = "limitPhotoUsed";
      limitMax = 5;
    } else if (type === "document") {
      cost = 10;
      limitField = "limitDocumentsUsed";
      limitMax = 3;
    } else {
      return res.status(400).json({ error: "Nieznany typ" });
    }

    // 1. Najpierw darmowy limit
if (user[limitField] < limitMax) {
  user[limitField] += 1;
  await user.save();

  return res.json({
    status: "ok",
    credits: user.credits,
    limitGenerateUsed: user.limitGenerateUsed,
    limitPhotoUsed: user.limitPhotoUsed,
    limitDocumentsUsed: user.limitDocumentsUsed
  });
}

// 2. Limit wyczerpany → sprawdzamy kredyty
if (user.credits < cost) {
  return res.status(403).json({ error: "Brak kredytów" });
}

// 3. Zużywamy kredyt
user.credits -= cost;
await user.save();

return res.json({
  status: "ok",
  credits: user.credits,
  limitGenerateUsed: user.limitGenerateUsed,
  limitPhotoUsed: user.limitPhotoUsed,
  limitDocumentsUsed: user.limitDocumentsUsed
});

  } catch (err) {
    console.error("❌ credits/use error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ===============================
// Start serwera
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Serwer działa na porcie " + PORT);
});
















