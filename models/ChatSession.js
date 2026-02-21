const mongoose = require("mongoose");

const ChatSessionSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    title: { type: String, required: true },
    lastUsedAt: { type: Date, default: Date.now },

    activeFileId: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatSession", ChatSessionSchema);
