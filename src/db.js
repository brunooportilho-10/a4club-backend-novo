const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

const query = (text, params) => pool.query(text, params);

const initDb = async () => {
  try {
    // Criar tabelas se não existirem
    await query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        senha VARCHAR(255) NOT NULL,
        nome VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS arquivos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        nome VARCHAR(255),
        url_r2 VARCHAR(255),
        md5 VARCHAR(32),
        tamanho INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        numero VARCHAR(50) UNIQUE,
        cliente VARCHAR(255),
        valor DECIMAL(10,2),
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('✅ Database tables initialized!');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
};

initDb();

module.exports = { query, pool };
