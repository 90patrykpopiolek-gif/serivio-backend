const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");

dotenv.config();

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  })
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

let chatsById = {};

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
// POST /chat
// - tworzy nowy czat jeśli brak chatId
// - kontynuuje istniejący jeśli chatId jest
// =======================================
app.post("/chat", async (req, res) => {
    try {
        const { userId, message, chatId } = req.body;

        if (!userId) return res.status(400).json({ error: "Brak userId" });
        if (!message || message.trim() === "")
            return res.status(400).json({ error: "Brak wiadomości" });

        let currentChatId = chatId;
        let chat;

        // NOWY CZAT
        if (!currentChatId || !chatsById[currentChatId]) {
            currentChatId = Date.now().toString();

            chat = {
                userId,
                title: generateTitleFromMessage(message),
                lastUsedAt: new Date().toISOString(),
                messages: []
            };

            chatsById[currentChatId] = chat;
        } else {
            // ISTNIEJĄCY CZAT
            chat = chatsById[currentChatId];
            chat.lastUsedAt = new Date().toISOString();
        }

        // Dodaj wiadomość użytkownika
        chat.messages.push({ role: "user", content: message });

        // Ogranicz historię
        if (chat.messages.length > 30) {
            chat.messages = chat.messages.slice(-30);
        }

        // Wyślij do modelu
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: chat.messages
        });

        const reply = completion.choices[0].message.content;

        // Dodaj odpowiedź AI
        chat.messages.push({ role: "assistant", content: reply });

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
// GET /history?chatId=...
// =======================================
app.get("/history", (req, res) => {
    const chatId = req.query.chatId;

    if (!chatId) return res.status(400).json({ error: "Brak chatId" });

    const chat = chatsById[chatId];

    if (!chat) return res.json({ history: [] });

    res.json({ history: chat.messages });
});

// =======================================
// GET /chats?userId=...
// =======================================
app.get("/chats", (req, res) => {
    const userId = req.query.userId;

    if (!userId) return res.status(400).json({ error: "Brak userId" });

    const sessions = Object.entries(chatsById)
        .filter(([id, chat]) => chat.userId === userId)
        .map(([id, chat]) => ({
            chatId: id,
            title: chat.title,
            lastUsedAt: chat.lastUsedAt
        }))
        .sort((a, b) => (b.lastUsedAt || "").localeCompare(a.lastUsedAt || ""));

    res.json(sessions);
});

// =======================================
// POST /reset
// usuwa wszystkie czaty użytkownika
// =======================================
app.post("/reset", (req, res) => {
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ error: "Brak userId" });

    for (const [id, chat] of Object.entries(chatsById)) {
        if (chat.userId === userId) {
            delete chatsById[id];
        }
    }

    res.json({ status: "reset" });
});

app.listen(3000, () => {
    console.log("Serwer działa na porcie 3000");
});







