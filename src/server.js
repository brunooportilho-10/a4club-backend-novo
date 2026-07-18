const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Backend funcionando!' });
});

// Test
app.get('/test', (req, res) => {
  res.json({ status: 'ok' });
});

// Login teste
app.post('/auth/login', (req, res) => {
  const { email, senha } = req.body;
  
  if (email === 'camila@a4digital.com.br' && senha === 'senha123') {
    res.json({
      token: 'token-teste-123',
      user: { id: 1, email, nome: 'Camila' }
    });
  } else {
    res.status(401).json({ error: 'Inválido' });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Backend rodando na porta ${PORT}`);
});
