const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./db');

const authRoutes = require('./routes/auth');
const importRoutes = require('./routes/import');
const filesRoutes = require('./routes/files');

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'A4 CLUB Backend is running!' });
});

// Routes
app.use('/auth', authRoutes);
app.use('/import', importRoutes);
app.use('/files', filesRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;

// Start server
const startServer = async () => {
  try {
    await db.query('SELECT NOW()');
    console.log('✅ Database connected!');
    
    app.listen(PORT, () => {
      console.log(`🚀 A4 CLUB Backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }
};

startServer();

module.exports = app;
