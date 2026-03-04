const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  _id: String, // Firebase UID

  // Kredyty użytkownika
  credits: { type: Number, default: 0 },

  // Limity dzienne
  limitGenerateUsed: { type: Number, default: 0 },   // generowanie obrazów (limit 2)
  limitPhotoUsed: { type: Number, default: 0 },      // zdjęcia/aparat (limit 5)
  limitDocumentsUsed: { type: Number, default: 0 },  // dokumenty (limit 3)

  // Data ostatniego resetu limitów
  lastLimitsReset: { type: Date, default: null }
});

module.exports = mongoose.model("User", UserSchema);


