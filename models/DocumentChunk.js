const mongoose = require("mongoose");

const DocumentChunkSchema = new mongoose.Schema({
  chatId: String,
  userId: String,
  documentId: String,
  chunkIndex: Number,
  text: String,
  embedding: [Number]
});

module.exports = mongoose.model("DocumentChunk", DocumentChunkSchema);

