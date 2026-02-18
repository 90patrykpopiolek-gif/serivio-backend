const mongoose = require("mongoose");

const FileSchema = new mongoose.Schema({
  fileId: { type: String, required: true },
  chatId: { type: String, required: true },
  path: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("File", FileSchema);

