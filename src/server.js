const express = require('express');
const app = express();

app.get('/', (req, res) => res.json({ ok: true }));
app.get('/health', (req, res) => res.json({ ok: true, message: 'Working' }));
app.post('/auth/login', (req, res) => res.json({ token: 'test', user: { id: 1 } }));

app.listen(3000);
