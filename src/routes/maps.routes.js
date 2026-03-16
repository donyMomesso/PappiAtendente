const express = require("express");
const { quoteByAddress, reverseGeocode } = require("../services/maps.service");

const router = express.Router();

router.get("/maps/quote", async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: "address_required" });

    const result = await quoteByAddress(address);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/maps/reverse", async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: "lat_lng_required" });

    const address = await reverseGeocode(lat, lng);
    res.json({ formatted_address: address });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

