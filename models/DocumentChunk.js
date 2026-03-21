const mongoose = require("mongoose");

const DocumentChunkSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  text: { type: String, required: true },
  embedding: { type: [Number], required: true }
});

module.exports = mongoose.model("DocumentChunk", DocumentChunkSchema);
