const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// Initialize database
const db = new sqlite3.Database("./warehouse.db", (err) => {
  if (err) {
    console.error("Database connection error:", err);
  } else {
    console.log("✓ Connected to warehouse database");
  }
});

// Create tables
db.serialize(() => {
  // Pallets table
  db.run(
    `CREATE TABLE IF NOT EXISTS pallets (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    location TEXT NOT NULL,
    date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
    date_removed DATETIME,
    status TEXT DEFAULT 'active'
  )`,
    (err) => {
      if (err) console.error("Error creating pallets table:", err);
      else console.log("✓ Pallets table ready");
    },
  );

  // Locations table
  db.run(
    `CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    aisle TEXT,
    rack INTEGER,
    level INTEGER,
    is_occupied INTEGER DEFAULT 0
  )`,
    (err) => {
      if (err) console.error("Error creating locations table:", err);
      else console.log("✓ Locations table ready");
    },
  );

  // Activity/History table
  db.run(
    `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pallet_id TEXT,
    customer_name TEXT,
    product_id TEXT,
    action TEXT,
    quantity_changed INTEGER,
    quantity_before INTEGER,
    quantity_after INTEGER,
    location TEXT,
    notes TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
    (err) => {
      if (err) console.error("Error creating activity_log table:", err);
      else console.log("✓ Activity log table ready");
    },
  );

  // Populate locations if empty
  db.get("SELECT COUNT(*) as count FROM locations", (err, row) => {
    if (err) {
      console.error("Error checking locations:", err);
      return;
    }

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

      stmt.finalize(() => {
        console.log("✓ Initialized 480 rack locations (A-J, 1-8, L1-L6)");
      });
    } else {
      console.log(`✓ Found ${row.count} existing locations`);
    }
  });
});

// API Routes

// Get all active pallets
app.get("/api/pallets", (req, res) => {
  const { customer } = req.query;

  let query = 'SELECT * FROM pallets WHERE status = "active"';
  let params = [];

  if (customer) {
    query += " AND customer_name = ?";
    params.push(customer);
  }

  query += " ORDER BY date_added DESC";

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Search pallets
app.get("/api/pallets/search", (req, res) => {
  const { q } = req.query;
  db.all(
    'SELECT * FROM pallets WHERE status = "active" AND (product_id LIKE ? OR location LIKE ? OR customer_name LIKE ?) ORDER BY date_added DESC',
    [`%${q}%`, `%${q}%`, `%${q}%`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

// Check in a pallet
app.post("/api/pallets", (req, res) => {
  const { id, customer_name, product_id, quantity, location } = req.body;

  if (!customer_name || !product_id || !location) {
    return res
      .status(400)
      .json({ error: "Customer name, Product ID and location required" });
  }

  const palletId = id || `PLT-${Date.now()}`;

  db.run(
    "INSERT INTO pallets (id, customer_name, product_id, quantity, location) VALUES (?, ?, ?, ?, ?)",
    [palletId, customer_name, product_id, quantity || 1, location],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run("UPDATE locations SET is_occupied = 1 WHERE id = ?", [location]);

      // Log activity
      db.run(
        "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_after, location) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          palletId,
          customer_name,
          product_id,
          "CHECK_IN",
          quantity || 1,
          quantity || 1,
          location,
        ],
      );

      res.json({
        id: palletId,
        customer_name,
        product_id,
        quantity: quantity || 1,
        location,
        message: "Pallet checked in successfully",
      });
    },
  );
});

// Partial quantity removal
app.post("/api/pallets/:id/remove-quantity", (req, res) => {
  const { id } = req.params;
  const { quantity_to_remove } = req.body;

  if (!quantity_to_remove || quantity_to_remove <= 0) {
    return res.status(400).json({ error: "Valid quantity required" });
  }

  db.get(
    'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
    [id, id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Pallet not found" });

      const quantityBefore = row.quantity;
      const quantityAfter = quantityBefore - quantity_to_remove;

      if (quantityAfter < 0) {
        return res
          .status(400)
          .json({ error: "Cannot remove more than available quantity" });
      }

      if (quantityAfter === 0) {
        // Remove entire pallet if quantity reaches 0
        db.run(
          'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, quantity = 0 WHERE id = ?',
          [row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [
              row.location,
            ]);

            // Log activity
            db.run(
              "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                row.id,
                row.customer_name,
                row.product_id,
                "PARTIAL_REMOVE",
                quantity_to_remove,
                quantityBefore,
                0,
                row.location,
                "Pallet emptied and removed",
              ],
            );

            res.json({
              message: "All quantity removed. Pallet checked out.",
              quantity_removed: quantity_to_remove,
              quantity_remaining: 0,
              pallet_removed: true,
            });
          },
        );
      } else {
        // Update quantity
        db.run(
          "UPDATE pallets SET quantity = ? WHERE id = ?",
          [quantityAfter, row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // Log activity
            db.run(
              "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [
                row.id,
                row.customer_name,
                row.product_id,
                "PARTIAL_REMOVE",
                quantity_to_remove,
                quantityBefore,
                quantityAfter,
                row.location,
              ],
            );

            res.json({
              message: `Removed ${quantity_to_remove} units. ${quantityAfter} remaining.`,
              quantity_removed: quantity_to_remove,
              quantity_remaining: quantityAfter,
              pallet_removed: false,
            });
          },
        );
      }
    },
  );
});

// Check out a pallet (remove entirely)
app.delete("/api/pallets/:id", (req, res) => {
  const { id } = req.params;

  db.get(
    'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
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

          // Log activity
          db.run(
            "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, location, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              row.id,
              row.customer_name,
              row.product_id,
              "CHECK_OUT",
              row.quantity,
              row.quantity,
              row.location,
              "Full pallet removed",
            ],
          );

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
  const { customer } = req.query;

  let palletQuery =
    'SELECT COUNT(*) as total_pallets FROM pallets WHERE status = "active"';
  let params = [];

  if (customer) {
    palletQuery += " AND customer_name = ?";
    params.push(customer);
  }

  db.get(palletQuery, params, (err, palletRow) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(
      `SELECT 
        (SELECT COUNT(*) FROM locations WHERE is_occupied = 1) as occupied_locations,
        (SELECT COUNT(*) FROM locations) as total_locations`,
      (err, locationRow) => {
        if (err) return res.status(500).json({ error: err.message });

        res.json({
          total_pallets: palletRow.total_pallets,
          occupied_locations: locationRow.occupied_locations,
          total_locations: locationRow.total_locations,
        });
      },
    );
  });
});

// Get activity log
app.get("/api/activity", (req, res) => {
  const { customer, limit } = req.query;

  let query = "SELECT * FROM activity_log";
  let params = [];

  if (customer) {
    query += " WHERE customer_name = ?";
    params.push(customer);
  }

  query += " ORDER BY timestamp DESC";

  if (limit) {
    query += " LIMIT ?";
    params.push(parseInt(limit));
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Export to CSV
app.get("/api/export", (req, res) => {
  const { customer } = req.query;

  let query = 'SELECT * FROM pallets WHERE status = "active"';
  let params = [];

  if (customer) {
    query += " AND customer_name = ?";
    params.push(customer);
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const csv = ["Customer,Product ID,Quantity,Location,Date Added"]
      .concat(
        rows.map(
          (p) =>
            `${p.customer_name},${p.product_id},${p.quantity},${p.location},${p.date_added}`,
        ),
      )
      .join("\n");

    res.header("Content-Type", "text/csv");
    res.attachment("inventory.csv");
    res.send(csv);
  });
});

// Get list of customers
app.get("/api/customers", (req, res) => {
  db.all(
    'SELECT DISTINCT customer_name FROM pallets WHERE status = "active" ORDER BY customer_name',
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map((r) => r.customer_name));
    },
  );
});

// Get network interfaces to display IP addresses
function getLocalIPs() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  
  return results;
}

// Check if SSL certificates exist
const sslKeyPath = path.join(__dirname, 'ssl', 'key.pem');
const sslCertPath = path.join(__dirname, 'ssl', 'cert.pem');
const hasSSL = fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath);

// Start HTTP server
http.createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log("\n🚀 Warehouse Server Running!");
  console.log(`\n📱 Access from devices on network:`);
  console.log(`   Local: http://localhost:${PORT}`);

  const ips = getLocalIPs();
  ips.forEach((ip) => {
    console.log(`   Network: http://${ip}:${PORT}`);
  });

  if (!hasSSL) {
    console.log("\n⚠️  HTTPS not enabled - camera features require HTTPS!");
    console.log("   To enable HTTPS, run: npm run generate-ssl");
  }
  console.log("");
});

// Start HTTPS server if certificates exist
if (hasSSL) {
  const httpsOptions = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath),
  };

  https.createServer(httpsOptions, app).listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log("\n🔒 HTTPS Server Running!");
    console.log(`\n📱 Secure access (for camera features):`);
    console.log(`   Local: https://localhost:${HTTPS_PORT}`);

    const ips = getLocalIPs();
    ips.forEach((ip) => {
      console.log(`   Network: https://${ip}:${HTTPS_PORT}`);
    });

    console.log("\n✅ Camera scanning will work on mobile devices!");
    console.log(
      "   (You may need to accept the self-signed certificate warning)\n",
    );
  });
}