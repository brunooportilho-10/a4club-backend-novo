const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ FIREBASE ADMIN ============
// A variavel FIREBASE_SERVICE_ACCOUNT deve conter o JSON completo da service account
let firebaseOk = false;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseOk = true;
    console.log('Firebase Admin inicializado: ' + serviceAccount.project_id);
  } else {
    console.log('AVISO: FIREBASE_SERVICE_ACCOUNT nao configurada');
  }
} catch (e) {
  console.log('ERRO ao inicializar Firebase Admin: ' + e.message);
}

// ============ MIDDLEWARES ============
app.use(cors({
  origin: [
    'https://a4club-frontend1-production.up.railway.app',
    'http://localhost:3001',
    'http://localhost:3000',
  ],
  credentials: true,
}));

app.use(express.json());

// Middleware de autenticacao: valida o ID token do Firebase
async function autenticar(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ erro: 'Token nao enviado' });
    }
    const decoded = await admin.auth().verifyIdToken(token);
    req.usuario = { uid: decoded.uid, email: decoded.email };
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Token invalido ou expirado' });
  }
}

// ============ ROTAS PUBLICAS ============
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'A4 CLUB Backend Online!',
    firebase: firebaseOk,
    versao: 'etapa-1',
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// ============ ROTAS PROTEGIDAS ============
// Rota de teste: confirma que o token do frontend esta sendo validado
app.get('/api/me', autenticar, (req, res) => {
  res.json({ ok: true, usuario: req.usuario });
});

// ============ START ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('Rodando na porta ' + PORT);
});
