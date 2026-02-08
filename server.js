const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.API_KEY });

//PAMIĘĆ KONTEKSTU — historia rozmowy
let conversationHistory = [];

app.post("/chat", async (req, res) => {
    try {
        const userMessage = req.body.message;

        //WALIDACJA — Android czasem wysyła pusty tekst
        if (!userMessage || typeof userMessage !== "string" || userMessage.trim() === "") {
            return res.status(400).json({ error: "Brak wiadomości" });
        }

        //Dodaj wiadomość użytkownika do historii
        conversationHistory.push({
            role: "user",
            content: userMessage
        });

        //Ogranicz historię do 30 ostatnich wiadomości
        if (conversationHistory.length > 30) {
            conversationHistory = conversationHistory.slice(-30);
        }

        //Wyślij CAŁĄ historię do modelu
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: conversationHistory
        });

        const reply = completion.choices[0].message.content;

        //Dodaj odpowiedź AI do historii
        conversationHistory.push({
            role: "assistant",
            content: reply
        });

        res.json({ reply });

    } catch (error) {
        console.error("Chat error:", error);
        res.status(500).json({ error: "Błąd serwera" });
    }
});

//(Opcjonalnie) reset pamięci
app.post("/reset", (req, res) => {
    conversationHistory = [];
    res.json({ status: "reset" });
});

app.listen(3000, () => {
    console.log("Serwer działa na porcie 3000");
});


