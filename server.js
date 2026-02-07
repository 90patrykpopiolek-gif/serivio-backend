const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.API_KEY });

app.post("/chat", async (req, res) => {
    try {
        const userMessage = req.body.message;

        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "user", content: userMessage }
            ]
        });

        const reply = completion.choices[0].message.content;

        res.json({ reply });
    } catch (error) {
        console.error("Chat error:", error);
        res.status(500).json({ error: "Błąd serwera" });
    }
});

app.listen(3000, () => {
    console.log("Serwer działa na porcie 3000");
});

