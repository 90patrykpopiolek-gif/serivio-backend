const mongoose = require("mongoose");

const FileSchema = new mongoose.Schema({
  fileId: { type: String, required: true },
  chatId: { type: String, required: true },
  path: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Indeks po chatId — szybkie usuwanie plików czatu
FileSchema.index({ chatId: 1 });

//  Indeks po createdAt — szybkie czyszczenie starych plików
FileSchema.index({ createdAt: 1 });

module.exports = mongoose.model("File", FileSchema);


