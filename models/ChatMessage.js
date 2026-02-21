const mongoose = require("mongoose");

const ChatMessageSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true },
    role: { type: String, required: true },

    type: { type: String, default: "text" },
    content: { type: String, required: true },
    imageData: { type: String, default: null },
    documentText: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatMessage", ChatMessageSchema);

