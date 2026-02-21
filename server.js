const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const ChatSession = require("./models/ChatSession");
const ChatMessage = require("./models/ChatMessage");
const File = require("./models/File");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const pdfParse = require("pdf-parse");
const { Document } = require("docx");
const fs = require("fs");
const path = require("path");

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

dotenv.config();

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Połączono z MongoDB"))
  .catch(err => console.error("Błąd połączenia z MongoDB:", err));

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.API_KEY });

// =======================================
// STRUKTURA: WIELE CZATÓW
// =======================================
//
// chatsById = {
//   "chatId123": {
//      userId: "user123",
//      title: "Plan treningowy",
//      lastUsedAt: "2026-02-13T11:22:33.000Z",
//      messages: [ { role, content }, ... ]
//   },
//   ...
// }

// =======================================
// GENEROWANIE TYTUŁU CZATU
// =======================================
function generateTitleFromMessage(message) {
    if (!message) return "Nowa rozmowa";

    let title = message.split("\n")[0].trim();

    if (title.length > 40) {
        title = title.slice(0, 37) + "...";
    }

    return title.charAt(0).toUpperCase() + title.slice(1);
}

// =======================================
// POST /chat — zapis do MongoDB + dokumenty
// =======================================
app.post("/chat", async (req, res) => {
  try {
    const { userId, message, chatId } = req.body;

    if (!userId) return res.status(400).json({ error: "Brak userId" });
    if (!message || message.trim() === "")
      return res.status(400).json({ error: "Brak wiadomości" });

    let currentChatId = chatId;

    // NOWY CZAT
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

    // Zapisz wiadomość użytkownika
    await ChatMessage.create({
      chatId: currentChatId,
      role: "user",
      content: message
    });

    // Pobierz historię do modelu
    const history = await ChatMessage.find({ chatId: currentChatId })
  .sort({ createdAt: 1 })
  .limit(10); // zmniejszamy historię, żeby nie przekraczać limitu tokenów

const messagesForModel = history.map(m => ({
  role: m.role,
  content: typeof m.content === "string" ? m.content : ""
}));

    // DOŁĄCZANIE OSTATNIEGO OPISU ZDJĘCIA
const lastImageDescription = await ChatMessage.findOne({
  chatId: currentChatId,
  type: "image_description"
}).sort({ createdAt: -1 });

if (lastImageDescription && lastImageDescription.imageDescription) {
  messagesForModel.push({
    role: "user",
    content:
      `Opis ostatniego zdjęcia użytkownika:\n` +
      `${lastImageDescription.imageDescription}\n\n` +
      `Użytkownik teraz pyta: ${message}`
  });
}

    // AUTOMATYCZNE DOŁĄCZANIE AKTYWNEGO DOKUMENTU
    const session = await ChatSession.findOne({ chatId: currentChatId });

    if (session?.activeFileId) {
      const file = await File.findOne({ fileId: session.activeFileId });

      if (file) {
        // Szukamy ostatniej wiadomości typu "document"
        const docMessage = await ChatMessage.findOne({
  chatId: currentChatId,
  type: "document"
}).sort({ createdAt: -1 });

        if (docMessage && docMessage.documentSummary) {
  messagesForModel.push({
    role: "user",
    content:
      `Oto streszczenie dokumentu:\n\n` +
      `${docMessage.documentSummary}\n\n` +
      `Użytkownik pyta: ${message}`
  });
}
        // UWAGA: brak obsługi obrazu w /chat — zdjęcia obsługuje /upload
      }
    }

    // Wyślij do modelu tekstowego
const completion = await groq.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: messagesForModel,
  max_tokens: 800
});

    const reply = completion.choices[0].message.content;

    // Zapisz odpowiedź AI
    await ChatMessage.create({
      chatId: currentChatId,
      role: "assistant",
      content: reply
    });

    res.json({
      reply,
      chatId: currentChatId
    });

  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// =======================================
// GET /history — pobieranie historii z MongoDB
// =======================================
app.get("/history", async (req, res) => {
  const chatId = req.query.chatId;

  if (!chatId) return res.status(400).json({ error: "Brak chatId" });

  const history = await ChatMessage.find({ chatId }).sort({ createdAt: 1 });

  res.json({ history });
});

// =======================================
// GET /chats — lista czatów z MongoDB (poprawiona)
// =======================================
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

// =======================================
// POST /reset — usuwa czaty użytkownika
// =======================================
app.post("/reset", async (req, res) => {
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ error: "Brak userId" });

  await ChatSession.deleteMany({ userId });
  await ChatMessage.deleteMany({ userId });

  //  USUWANIE WSZYSTKICH PLIKÓW UŻYTKOWNIKA
const userFiles = await File.find({ userId });

for (const f of userFiles) {
  try {
    if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
  } catch (err) {
    console.error("Błąd usuwania pliku:", err);
  }
}

await File.deleteMany({ userId });

  res.json({ status: "reset" });
});

// =======================================
// POST /deleteChat — usuwa jeden czat
// =======================================
app.post("/deleteChat", async (req, res) => {
  const { userId, chatId } = req.body;

  if (!userId) return res.status(400).json({ error: "Brak userId" });
  if (!chatId) return res.status(400).json({ error: "Brak chatId" });

  try {
    // Usuń sesję czatu
    await ChatSession.deleteOne({ userId, chatId });

    // Usuń wszystkie wiadomości z tego czatu
    await ChatMessage.deleteMany({ chatId });

    //  USUWANIE WSZYSTKICH PLIKÓW POWIĄZANYCH Z CZATEM
const files = await File.find({ chatId });

for (const f of files) {
  try {
    if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
  } catch (err) {
    console.error("Błąd usuwania pliku:", err);
  }
}

await File.deleteMany({ chatId });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Delete chat error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// =======================================
// POST /upload — analiza zdjęcia (Vision)
// =======================================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { userId, chatId, message } = req.body;

    if (!userId) return res.status(400).json({ error: "Brak userId" });
    if (!req.file) return res.status(400).json({ error: "Brak pliku!" });

    let currentChatId = chatId;

    // Jeśli nie ma czatu — tworzymy nowy
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

    //  ZAPIS PLIKU NA DYSKU
const fileId = Date.now().toString();
const filePath = path.join(UPLOAD_DIR, fileId);
fs.writeFileSync(filePath, req.file.buffer);

//  ZAPIS METADANYCH W MONGO
await File.create({
  fileId,
  chatId: currentChatId,
  path: filePath
});

//  USTAWIENIE AKTYWNEGO PLIKU
await ChatSession.updateOne(
  { chatId: currentChatId },
  { activeFileId: fileId }
);

    // Konwersja zdjęcia do base64
    const base64Image = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    // Zapis zdjęcia jako wiadomość
    await ChatMessage.create({
      chatId: currentChatId,
      role: "user",
      type: "image",
      content: message && message.trim() !== "" ? message : "[IMAGE]",
      imageData: base64Image
    });

    //  Budujemy prompt zależnie od tego, czy użytkownik napisał tekst
    let promptText = "";

    if (!message || message.trim() === "") {
  promptText = 
    "Użytkownik wysłał zdjęcie bez tekstu. " +
    "Opisz bardzo szczegółowo wszystko, co widzisz na zdjęciu. " +
    "Uwzględnij wszystkie obiekty, zwierzęta, kolory, tło, meble, małe detale, " +
    "położenie elementów, tekstury i wszystko, co może być istotne.";
} else {
  promptText =
    `Użytkownik napisał: "${message}". ` +
    "Najpierw opisz bardzo szczegółowo wszystko, co widzisz na zdjęciu. " +
    "Uwzględnij obiekty, zwierzęta, kolory, tło, meble, małe detale, " +
    "położenie elementów i tekstury. " +
    "Następnie odpowiedz na pytanie użytkownika w sposób rozmowny i pomocny.";
}

    // Wysyłamy do modelu
    const completion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ],
      max_tokens: 600,
      temperature: 0.4
    });

    const reply = completion.choices[0].message.content.trim();

    // Zapis odpowiedzi AI
    await ChatMessage.create({
      chatId: currentChatId,
      role: "assistant",
      type: "text",
      content: reply
    });

    // Zapis opisu zdjęcia jako osobna wiadomość systemowa
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
  }
});

// =======================================
// POST /upload-document — analiza PDF/DOCX/TXT
// =======================================
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

    //  ZAPIS PLIKU NA DYSKU
const fileId = Date.now().toString();
const filePath = path.join(UPLOAD_DIR, fileId);
fs.writeFileSync(filePath, req.file.buffer);

//  ZAPIS METADANYCH W MONGO
await File.create({
  fileId,
  chatId: currentChatId,
  path: filePath
});

//  USTAWIENIE AKTYWNEGO PLIKU
await ChatSession.updateOne(
  { chatId: currentChatId },
  { activeFileId: fileId }
);

    const text = await extractTextFromDocument(req.file);

    // Generowanie streszczenia dokumentu
const summaryPrompt = `
Streść ten dokument w maksymalnie 20 zdaniach.
Skup się na najważniejszych informacjach, pomijaj szczegóły techniczne.

---
${text}
---
`;

const summaryCompletion = await groq.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: summaryPrompt }],
  max_tokens: 500
});

const summary = summaryCompletion.choices[0].message.content.trim();


    await ChatMessage.create({
  chatId: currentChatId,
  role: "user",
  type: "document",
  content: message || "[DOCUMENT]",
  documentText: text,
  documentSummary: summary
});

    const prompt = `
Oto treść dokumentu:

---
${text}
---

Użytkownik pyta: "${message || "Streszcz dokument"}"

Odpowiedz tylko na podstawie dokumentu.
    `;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }]
    });

    const reply = completion.choices[0].message.content.trim();

    await ChatMessage.create({
      chatId: currentChatId,
      role: "assistant",
      type: "text",
      content: reply
    });

    res.json({ reply, chatId: currentChatId });

  } catch (err) {
    console.error("❌ Błąd dokumentu:", err);
    res.status(500).json({ error: "Błąd serwera podczas analizy dokumentu" });
  }
});

// =======================================
// WYCIĄGANIE TEKSTU Z DOKUMENTÓW
// =======================================
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

//  AUTOMATYCZNE USUWANIE PLIKÓW STARSZYCH NIŻ 24H
setInterval(async () => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h

  const oldFiles = await File.find({
    createdAt: { $lt: new Date(cutoff) }
  });

  for (const f of oldFiles) {
    try {
      if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
    } catch (err) {
      console.error("Błąd usuwania starego pliku:", err);
    }
  }

  await File.deleteMany({
    createdAt: { $lt: new Date(cutoff) }
  });

}, 60 * 60 * 1000); // sprawdzaj co godzinę


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Serwer działa na porcie " + PORT);
});































