const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Database pool error:', err);
});

const query = (text, params) => pool.query(text, params);

const initDb = async () => {
  try {
    const result = await query('SELECT NOW()');
    console.log('✅ Database connected!', result.rows[0]);
    
    await query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        senha VARCHAR(255) NOT NULL,
        nome VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('✅ Tables created!');
  } catch (err) {
    console.error('Database error:', err.message);
  }
};

module.exports = { query, pool, initDb };
