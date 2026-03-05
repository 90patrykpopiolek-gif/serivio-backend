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
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { Document } = require("docx");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fal } = require("@fal-ai/client");

dotenv.config();

fal.config({
  credentials: process.env.FAL_KEY,
});

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
- Jeśli pytanie wymaga aktualnych danych (np. polityka, daty, wydarzenia, fakty po 2023), możesz korzystać z wyników wyszukiwania internetowego.
- Jeśli nie masz danych — mówisz "Nie wiem" lub "Nie mam dostępu do aktualnych danych".
- Nie powtarzasz zachęt typu "zadaj pytanie".
- Odpowiadasz konkretnie i bez lania wody.
- Nie mieszasz języków — trzymasz się języka użytkownika.
- Jeśli pytanie jest niejasne — prosisz o doprecyzowanie.
- Nie wymyślasz faktów.
`;

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

    // Historia — więcej kontekstu
    const history = await ChatMessage.find({ chatId: currentChatId })
      .sort({ createdAt: 1 })
      .limit(10);

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
      {
        role: "system",
        content: searchResults
          ? `Wyniki wyszukiwania internetowego:\n${searchResults}`
          : "Brak wyników wyszukiwania."
      },
      ...history.map(m => ({
        role: m.role,
        content: m.content
      }))
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: messagesForModel,
      max_tokens: 800,
      temperature: 0.3
    });

    const reply = completion.choices[0].message.content;

    console.log("RAW MODEL RESPONSE:", JSON.stringify(completion, null, 2));
console.log("EXTRACTED reply:", reply);

    await ChatMessage.create({
  chatId: currentChatId,
  role: "assistant",
  content: reply || "[EMPTY_REPLY]",   // ← zabezpieczenie
  type: "text"
});

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
      max_tokens: 600,
      temperature: 0.4
    });

    const reply = completion.choices[0].message.content.trim();

    await ChatMessage.create({
  chatId: currentChatId,
  role: "assistant",
  type: "text",
  content: reply || "[EMPTY_REPLY]"
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
app.post("/upload-document", upload.single("file"), async (req, res) => {
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
        title: "Dokument",
        lastUsedAt: new Date()
      });
    } else {
      await ChatSession.updateOne(
        { chatId: currentChatId },
        { lastUsedAt: new Date() }
      );
    }

    const text = await extractTextFromDocument(req.file);

    await ChatMessage.create({
      chatId: currentChatId,
      role: "user",
      type: "document",
      content: message || "[DOCUMENT]",
      documentText: text
    });

    const prompt = `
Użytkownik przesłał dokument. Oto jego treść:

${text}

Użytkownik pyta: "${message || "Opisz dokument"}"

Odpowiedz na podstawie treści dokumentu.
`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600
    });

    const reply = completion.choices[0].message.content.trim();

    await ChatMessage.create({
  chatId: currentChatId,
  role: "assistant",
  type: "text",
  content: reply || "[EMPTY_REPLY]"
});

    res.json({ reply, chatId: currentChatId });

  } catch (err) {
    console.error("❌ Błąd dokumentu:", err);
    res.status(500).json({ error: "Błąd serwera podczas analizy dokumentu" });
  }
});


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
// POST /generate-image — generowanie obrazów fal.ai
// ===============================
app.post("/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || prompt.trim() === "") {
      return res.status(400).json({ error: "Brak promptu" });
    }

    const result = await fal.subscribe("fal-ai/flux/dev", {
  input: { prompt },
});

// fal.ai zwraca wynik w result.output
const imageUrl = result?.output?.images?.[0]?.url;

if (!imageUrl) {
  console.error("❌ fal.ai nie zwróciło URL obrazu:", result);
  return res.status(500).json({ error: "Nie udało się wygenerować obrazu" });
}

res.json({ imageUrl });

  } catch (err) {
    console.error("❌ Błąd generowania obrazu:", err);
    res.status(500).json({ error: "Błąd generowania obrazu" });
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
    const imageUrl = `${process.env.BACKEND_URL || "https://serivio-backend.onrender.com"}/uploads/${fileName}`;

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
      max_tokens: 600,
      temperature: 0.3
    });

    const sceneDescription = visionCompletion.choices[0].message.content.trim();

    const wantsImage = /obraz|wygeneruj|zrób obraz|grafikę|zdjęcie z|stwórz scenę|zrób scenę/.test(
      (message || "").toLowerCase()
    );

    if (!wantsImage) {
      await ChatMessage.create({
        chatId: currentChatId,
        role: "assistant",
        type: "text",
        content: sceneDescription || "[EMPTY_REPLY]"
      });

      return res.json({
        type: "text",
        reply: sceneDescription,
        chatId: currentChatId
      });
    }

    const imagePrompt = `
Scena bazowa:
${sceneDescription}

Polecenie użytkownika:
${message || ""}

Stwórz NOWY obraz przedstawiający scenę podobną do opisanej powyżej,
uwzględniając polecenie użytkownika. Dopasuj perspektywę, światło i klimat.
`;

    const falResult = await fal.subscribe("fal-ai/flux/dev", {
      input: { prompt: imagePrompt }
    });

    const generatedImageUrl = falResult?.output?.images?.[0]?.url;

if (!generatedImageUrl) {
  console.error("❌ fal.ai nie zwróciło URL obrazu:", falResult);
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
    console.error("❌ Błąd /chat-image:", err);
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













