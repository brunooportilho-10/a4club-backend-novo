const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const db = require('../db');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.APP_URL + '/auth/google/callback'
);

// Google Drive auth
router.get('/google-auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.readonly']
  });
  res.json({ authUrl });
});

// List files from Google Drive
router.post('/files', async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'Access token é obrigatório' });
    }

    oauth2Client.setCredentials({ access_token: accessToken });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.list({
      pageSize: 50,
      fields: 'files(id, name, mimeType, size, createdTime)',
      q: "trashed = false"
    });

    res.json({
      files: response.data.files || [],
      message: 'Arquivos listados com sucesso'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Importar arquivo
router.post('/import-file', async (req, res) => {
  try {
    const { fileId, fileName, userId, accessToken } = req.body;

    if (!fileId || !fileName || !userId || !accessToken) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios ausentes' });
    }

    // Simulação: salvar referência no banco
    const result = await db.query(
      'INSERT INTO arquivos (usuario_id, nome) VALUES ($1, $2) RETURNING id',
      [userId, fileName]
    );

    res.json({
      success: true,
      fileId: result.rows[0].id,
      message: 'Arquivo importado com sucesso'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
