const express = require('express');
const router = express.Router();
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../db');

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.STORAGE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY
  }
});

// List files in R2
router.get('/list', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, nome, url_r2, tamanho, created_at FROM arquivos ORDER BY created_at DESC LIMIT 100'
    );

    res.json({
      files: result.rows,
      total: result.rows.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload to R2
router.post('/upload', async (req, res) => {
  try {
    const { fileName, fileContent, userId } = req.body;

    if (!fileName || !fileContent || !userId) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios ausentes' });
    }

    const key = `${userId}/${Date.now()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: key,
      Body: fileContent
    });

    await s3Client.send(command);

    const url = `${process.env.STORAGE_ENDPOINT}/${process.env.STORAGE_BUCKET}/${key}`;

    const result = await db.query(
      'INSERT INTO arquivos (usuario_id, nome, url_r2, tamanho) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, fileName, url, fileContent.length]
    );

    res.json({
      success: true,
      fileId: result.rows[0].id,
      url,
      message: 'Arquivo enviado com sucesso'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download from R2
router.get('/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    const result = await db.query(
      'SELECT url_r2 FROM arquivos WHERE id = $1',
      [fileId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }

    res.json({
      url: result.rows[0].url_r2,
      message: 'URL do arquivo'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
