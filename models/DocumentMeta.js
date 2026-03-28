const mongoose = require("mongoose");

const DocumentMetaSchema = new mongoose.Schema({
  documentId: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  chatId: { type: String, required: true },
  originalName: { type: String, required: true },
  status: { type: String, enum: ["processing", "ready", "error"], default: "processing" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("DocumentMeta", DocumentMetaSchema);
