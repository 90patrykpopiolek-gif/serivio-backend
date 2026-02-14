const mongoose = require("mongoose");

const ChatMessageSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  role: { type: String, required: true }, // "user" lub "assistant"
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model("ChatMessage", ChatMessageSchema);
