const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const ChatSession = require("./models/ChatSession");
const ChatMessage = require("./models/ChatMessage");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

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
// POST /chat — zapis do MongoDB
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
      .sort({ timestamp: 1 })
      .limit(30);

    const messagesForModel = history.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Wyślij do modelu
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: messagesForModel
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

  const history = await ChatMessage.find({ chatId }).sort({ timestamp: 1 });

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

    // 🔥 Budujemy prompt zależnie od tego, czy użytkownik napisał tekst
    let promptText = "";

    if (!message || message.trim() === "") {
      // SAMO ZDJĘCIE
      promptText = 
        "Użytkownik wysłał zdjęcie bez tekstu. " +
        "Opisz naturalnie i krótko co widzisz na zdjęciu (1–2 zdania).";
    } else {
      // ZDJĘCIE + TEKST
      promptText =
        `Użytkownik napisał: "${message}". ` +
        "Najpierw krótko i naturalnie opisz co widzisz na zdjęciu (1–2 zdania). " +
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

    res.json({ reply, chatId: currentChatId });

  } catch (err) {
    console.error("❌ Błąd uploadu:", err);
    res.status(500).json({ error: "Błąd serwera podczas uploadu" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Serwer działa na porcie " + PORT);
});






















