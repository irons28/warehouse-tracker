const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const db = new sqlite3.Database("./warehouse.db", (err) => {
  if (err) console.error(err);
  else console.log("Connected to warehouse database");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS pallets (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    location TEXT NOT NULL,
    date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
    date_removed DATETIME,
    status TEXT DEFAULT 'active'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    aisle TEXT,
    rack INTEGER,
    level INTEGER,
    is_occupied INTEGER DEFAULT 0
  )`);

  db.get("SELECT COUNT(*) as count FROM locations", (err, row) => {
    if (row.count === 0) {
      const aisles = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
      const stmt = db.prepare(
        "INSERT INTO locations (id, aisle, rack, level) VALUES (?, ?, ?, ?)",
      );

      aisles.forEach((aisle) => {
        for (let rack = 1; rack <= 8; rack++) {
          for (let level = 1; level <= 6; level++) {
            const locationId = `${aisle}${rack}-L${level}`;
            stmt.run(locationId, aisle, rack, level);
          }
        }
      });
      stmt.finalize();
      console.log("Locations initialized");
    }
  });
});

// API Routes
app.get("/api/pallets", (req, res) => {
  db.all(
    'SELECT * FROM pallets WHERE status = "active" ORDER BY date_added DESC',
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

app.get("/api/pallets/search", (req, res) => {
  const { q } = req.query;
  db.all(
    'SELECT * FROM pallets WHERE status = "active" AND (product_id LIKE ? OR location LIKE ?) ORDER BY date_added DESC',
    [`%${q}%`, `%${q}%`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

app.post("/api/pallets", (req, res) => {
  const { id, product_id, quantity, location } = req.body;

  if (!product_id || !location) {
    return res.status(400).json({ error: "Product ID and location required" });
  }

  const palletId = id || `PLT-${Date.now()}`;

  db.run(
    "INSERT INTO pallets (id, product_id, quantity, location) VALUES (?, ?, ?, ?)",
    [palletId, product_id, quantity || 1, location],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run("UPDATE locations SET is_occupied = 1 WHERE id = ?", [location]);

      res.json({
        id: palletId,
        product_id,
        quantity: quantity || 1,
        location,
        message: "Pallet checked in successfully",
      });
    },
  );
});

app.delete("/api/pallets/:id", (req, res) => {
  const { id } = req.params;

  db.get(
    "SELECT location FROM pallets WHERE id = ? OR product_id = ?",
    [id, id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Pallet not found" });

      db.run(
        'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP WHERE id = ? OR product_id = ?',
        [id, id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });

          db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [
            row.location,
          ]);

          res.json({ message: "Pallet checked out successfully" });
        },
      );
    },
  );
});

app.get("/api/locations", (req, res) => {
  db.all("SELECT * FROM locations ORDER BY aisle, rack, level", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/api/stats", (req, res) => {
  db.get(
    `SELECT 
      COUNT(*) as total_pallets,
      (SELECT COUNT(*) FROM locations WHERE is_occupied = 1) as occupied_locations,
      (SELECT COUNT(*) FROM locations) as total_locations
    FROM pallets WHERE status = "active"`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row);
    },
  );
});

app.get("/api/export", (req, res) => {
  db.all('SELECT * FROM pallets WHERE status = "active"', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const csv = ["Product ID,Quantity,Location,Date Added"]
      .concat(
        rows.map(
          (p) => `${p.product_id},${p.quantity},${p.location},${p.date_added}`,
        ),
      )
      .join("\n");

    res.header("Content-Type", "text/csv");
    res.attachment("inventory.csv");
    res.send(csv);
  });
});

// API Routes

// Get all active pallets
app.get("/api/pallets", (req, res) => {
  db.all(
    'SELECT * FROM pallets WHERE status = "active" ORDER BY date_added DESC',
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

// Search pallets
app.get("/api/pallets/search", (req, res) => {
  const { q } = req.query;
  db.all(
    'SELECT * FROM pallets WHERE status = "active" AND (product_id LIKE ? OR location LIKE ?) ORDER BY date_added DESC',
    [`%${q}%`, `%${q}%`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

// Check in a pallet
app.post("/api/pallets", (req, res) => {
  const { id, product_id, quantity, location } = req.body;

  if (!product_id || !location) {
    return res.status(400).json({ error: "Product ID and location required" });
  }

  const palletId = id || `PLT-${Date.now()}`;

  db.run(
    "INSERT INTO pallets (id, product_id, quantity, location) VALUES (?, ?, ?, ?)",
    [palletId, product_id, quantity || 1, location],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run("UPDATE locations SET is_occupied = 1 WHERE id = ?", [location]);

      res.json({
        id: palletId,
        product_id,
        quantity: quantity || 1,
        location,
        message: "Pallet checked in successfully",
      });
    },
  );
});

// Check out a pallet
app.delete("/api/pallets/:id", (req, res) => {
  const { id } = req.params;

  db.get(
    "SELECT location FROM pallets WHERE id = ? OR product_id = ?",
    [id, id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Pallet not found" });

      db.run(
        'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP WHERE id = ? OR product_id = ?',
        [id, id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });

          db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [
            row.location,
          ]);

          res.json({ message: "Pallet checked out successfully" });
        },
      );
    },
  );
});

// Get all locations
app.get("/api/locations", (req, res) => {
  db.all("SELECT * FROM locations ORDER BY aisle, rack, level", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get stats
app.get("/api/stats", (req, res) => {
  db.get(
    `SELECT 
      COUNT(*) as total_pallets,
      (SELECT COUNT(*) FROM locations WHERE is_occupied = 1) as occupied_locations,
      (SELECT COUNT(*) FROM locations) as total_locations
    FROM pallets WHERE status = "active"`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row);
    },
  );
});

// Export to CSV
app.get("/api/export", (req, res) => {
  db.all('SELECT * FROM pallets WHERE status = "active"', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const csv = ["Product ID,Quantity,Location,Date Added"]
      .concat(
        rows.map(
          (p) => `${p.product_id},${p.quantity},${p.location},${p.date_added}`,
        ),
      )
      .join("\n");

    res.header("Content-Type", "text/csv");
    res.attachment("inventory.csv");
    res.send(csv);
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log("\n🚀 Warehouse Server Running!");
  console.log(`\n📱 Access from devices on network:`);
  console.log(`   Local: http://localhost:${PORT}`);
  console.log('\n   Find your IP with: ifconfig | grep "inet "');
  console.log("   Then access at: http://YOUR_IP:3000\n");
});