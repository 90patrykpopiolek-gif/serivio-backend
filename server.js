const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.API_KEY });

// OSOBNE HISTORIE ROZMÓW DLA KAŻDEGO UŻYTKOWNIKA
let userConversations = {};

app.post("/chat", async (req, res) => {
    try {
        const userId = req.body.userId;
        const userMessage = req.body.message;

        // Walidacja userId
        if (!userId) {
            return res.status(400).json({ error: "Brak userId" });
        }

        // Walidacja wiadomości
        if (!userMessage || typeof userMessage !== "string" || userMessage.trim() === "") {
            return res.status(400).json({ error: "Brak wiadomości" });
        }

        // Jeśli użytkownik nie ma jeszcze historii — utwórz ją
        if (!userConversations[userId]) {
            userConversations[userId] = [];
        }

        // Dodaj wiadomość użytkownika
        userConversations[userId].push({
            role: "user",
            content: userMessage
        });

        // Ogranicz historię do 30 wiadomości
        if (userConversations[userId].length > 30) {
            userConversations[userId] = userConversations[userId].slice(-30);
        }

        // Wyślij historię do modelu
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: userConversations[userId]
        });

        const reply = completion.choices[0].message.content;

        // Dodaj odpowiedź AI
        userConversations[userId].push({
            role: "assistant",
            content: reply
        });

        res.json({ reply });

    } catch (error) {
        console.error("Chat error:", error);
        res.status(500).json({ error: "Błąd serwera" });
    }
});

// Reset historii dla jednego użytkownika
app.post("/reset", (req, res) => {
    const userId = req.body.userId;

    if (userId && userConversations[userId]) {
        userConversations[userId] = [];
    }

    res.json({ status: "reset" });
});

app.listen(3000, () => {
    console.log("Serwer działa na porcie 3000");
});




