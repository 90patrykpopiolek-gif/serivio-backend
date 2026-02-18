const mongoose = require("mongoose");

const ChatMessageSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  role: { type: String, required: true }, // "user" lub "assistant"

  // NOWE POLA
  type: { type: String, default: "text" }, // "text" | "image"
  content: { type: String, required: true }, // tekst lub placeholder "[IMAGE]"
  imageData: { type: String, default: null }, // base64 jeśli to zdjęcie
  documentText: { type: String, default: null }, // tekst dokumentu

  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model("ChatMessage", ChatMessageSchema);

