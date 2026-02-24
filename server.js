const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const ChatSession = require("./models/ChatSession");
const ChatMessage = require("./models/ChatMessage");
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50 MB
  }
});
const pdfParse = require("pdf-parse");
const { Document } = require("docx");
const fs = require("fs");
const path = require("path");

dotenv.config();

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Połączono z MongoDB"))
  .catch(err => console.error("Błąd połączenia z MongoDB:", err));

const app = express();
app.use(cors());

// pozwalamy na duże pliki (zdjęcia, PDF, DOCX)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const groq = new Groq({ apiKey: process.env.API_KEY });


// =======================================
// POST /chat — czat tekstowy
// =======================================
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

    const history = await ChatMessage.find({ chatId: currentChatId })
      .sort({ createdAt: 1 })
      .limit(5);

    const messagesForModel = history.map(m => ({
      role: m.role,
      content: m.content
    }));

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: messagesForModel,
      max_tokens: 800
    });

    const reply = completion.choices[0].message.content;

    await ChatMessage.create({
      chatId: currentChatId,
      role: "assistant",
      content: reply,
      type: "text"
    });

    res.json({ reply, chatId: currentChatId });

  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Błąd serwera" });
  }
});


// =======================================
// GET /history
// =======================================
app.get("/history", async (req, res) => {
  const chatId = req.query.chatId;
  if (!chatId) return res.status(400).json({ error: "Brak chatId" });

  const history = await ChatMessage.find({ chatId }).sort({ createdAt: 1 });
  res.json({ history });
});


// =======================================
// GET /chats
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
// POST /reset — usuwa czaty (bez plików zdjęć)
// =======================================
app.post("/reset", async (req, res) => {
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ error: "Brak userId" });

  await ChatSession.deleteMany({ userId });
  await ChatMessage.deleteMany({ userId });

  res.json({ status: "reset" });
});

// =======================================
// POST /deleteChat — usuwa czat (bez zdjęć)
// =======================================
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

// =======================================
// POST /upload — analiza zdjęcia (Vision) BEZ zapisu na dysku
// =======================================
app.post("/upload", upload.single("file"), async (req, res) => {
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

    let promptText = "";

    if (!message || message.trim() === "") {
      promptText =
        "Użytkownik wysłał zdjęcie bez tekstu. Opisz bardzo szczegółowo wszystko, co widzisz.";
    } else {
      promptText =
        `Użytkownik napisał: "${message}". Najpierw opisz zdjęcie, potem odpowiedz.`;
    }

    const completion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
  role: "user",
  content: [
    { type: "text", text: promptText },
    { type: "input_image", image: base64Image }
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
  }
});

// =======================================
// POST /upload-document — dokumenty 
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

    //  WYCIĄGAMY TEKST Z DOKUMENTU (PDF/DOCX/TXT)
    const text = await extractTextFromDocument(req.file);

    //  ZAPISUJEMY WIADOMOŚĆ UŻYTKOWNIKA (treść dokumentu)
    await ChatMessage.create({
      chatId: currentChatId,
      role: "user",
      type: "document",
      content: message || "[DOCUMENT]",
      documentText: text
    });

    //  PROMPT DO AI
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

    //  ZAPISUJEMY ODPOWIEDŹ AI
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

// =======================================
// START SERWERA
// =======================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Serwer działa na porcie " + PORT);
});










































