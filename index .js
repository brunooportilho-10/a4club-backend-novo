const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://a4club-frontend1-production.up.railway.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://a4club-backend-novo-production.up.railway.app';
const REDIRECT_URI = BACKEND_URL + '/auth/google/callback';

// E-mails com permissao de admin (separados por virgula na variavel ADMIN_EMAILS)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// ============ FIREBASE ADMIN ============
let firebaseOk = false;
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    firebaseOk = true;
    console.log('Firebase Admin inicializado: ' + serviceAccount.project_id);
  } else {
    console.log('AVISO: FIREBASE_SERVICE_ACCOUNT nao configurada');
  }
} catch (e) {
  console.log('ERRO ao inicializar Firebase Admin: ' + e.message);
}

// ============ GOOGLE OAUTH ============
function novoOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Carrega tokens salvos no Firestore e devolve um client autenticado (ou null)
async function clientComTokens() {
  if (!db) return null;
  const doc = await db.collection('config').doc('google_tokens').get();
  if (!doc.exists) return null;
  const oauth = novoOAuthClient();
  oauth.setCredentials(doc.data().tokens);
  // Salva tokens renovados automaticamente
  oauth.on('tokens', async (tokens) => {
    try {
      const atual = (await db.collection('config').doc('google_tokens').get()).data() || {};
      await db.collection('config').doc('google_tokens').set({
        tokens: { ...(atual.tokens || {}), ...tokens },
        atualizadoEm: new Date().toISOString(),
      });
    } catch (e) {
      console.log('Erro ao salvar tokens renovados: ' + e.message);
    }
  });
  return oauth;
}

// ============ MIDDLEWARES ============
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:3001', 'http://localhost:3000'],
  credentials: true,
}));

app.use(express.json());

async function autenticar(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ erro: 'Token nao enviado' });
    const decoded = await admin.auth().verifyIdToken(token);
    req.usuario = { uid: decoded.uid, email: (decoded.email || '').toLowerCase() };
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Token invalido ou expirado' });
  }
}

function somenteAdmin(req, res, next) {
  if (ADMIN_EMAILS.length === 0) return next(); // sem lista configurada, libera (fase de construcao)
  if (ADMIN_EMAILS.includes(req.usuario.email)) return next();
  return res.status(403).json({ erro: 'Acesso restrito ao administrador' });
}

// ============ ROTAS PUBLICAS ============
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'A4 CLUB Backend Online!',
    firebase: firebaseOk,
    versao: 'etapa-2',
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ============ AUTENTICACAO GOOGLE (Drive) ============
// Inicia o fluxo: redireciona para a tela de consentimento do Google
app.get('/auth/google', (req, res) => {
  const oauth = novoOAuthClient();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  res.redirect(url);
});

// Mesmo fluxo, mas devolve a URL em JSON (para o frontend abrir em nova aba)
app.get('/admin/auth/google', autenticar, somenteAdmin, (req, res) => {
  const oauth = novoOAuthClient();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  res.json({ ok: true, url });
});

// Callback: troca o codigo por tokens e salva no Firestore
app.get('/auth/google/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Codigo nao recebido');
    const oauth = novoOAuthClient();
    const { tokens } = await oauth.getToken(code);
    await db.collection('config').doc('google_tokens').set({
      tokens,
      conectadoEm: new Date().toISOString(),
    });
    res.redirect(FRONTEND_URL + '/admin?drive=conectado');
  } catch (e) {
    console.log('Erro no callback Google: ' + e.message);
    res.status(500).send('Erro ao conectar com o Google: ' + e.message);
  }
});

// Status da conexao com o Drive
app.get('/admin/drive/status', autenticar, somenteAdmin, async (req, res) => {
  try {
    const doc = await db.collection('config').doc('google_tokens').get();
    if (!doc.exists) return res.json({ ok: true, conectado: false });
    res.json({ ok: true, conectado: true, conectadoEm: doc.data().conectadoEm || null });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ============ LISTAGEM DO DRIVE ============
// Lista pastas do nivel principal do Meu Drive + Drives compartilhados + pastas compartilhadas comigo
app.get('/admin/drives', autenticar, somenteAdmin, async (req, res) => {
  try {
    const oauth = await clientComTokens();
    if (!oauth) {
      return res.status(400).json({ erro: 'Google Drive nao conectado. Conecte primeiro.', conectado: false });
    }
    const drive = google.drive({ version: 'v3', auth: oauth });

    // 1. Pastas na raiz do Meu Drive
    const raiz = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false",
      fields: 'files(id, name)',
      pageSize: 100,
    });

    // 2. Pastas compartilhadas comigo
    const compartilhadas = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and sharedWithMe=true and trashed=false",
      fields: 'files(id, name, owners(displayName, emailAddress))',
      pageSize: 100,
    });

    // 3. Drives compartilhados (Shared Drives)
    let sharedDrives = [];
    try {
      const sd = await drive.drives.list({ pageSize: 50 });
      sharedDrives = (sd.data.drives || []).map((d) => ({ id: d.id, nome: d.name, tipo: 'shared_drive' }));
    } catch (e) {
      // conta pode nao ter shared drives; ignora
    }

    const pastas = [
      ...(raiz.data.files || []).map((f) => ({ id: f.id, nome: f.name, tipo: 'meu_drive' })),
      ...(compartilhadas.data.files || []).map((f) => ({
        id: f.id,
        nome: f.name,
        tipo: 'compartilhada',
        dono: f.owners && f.owners[0] ? f.owners[0].emailAddress : null,
      })),
      ...sharedDrives,
    ];

    res.json({ ok: true, pastas });
  } catch (e) {
    console.log('Erro ao listar drives: ' + e.message);
    res.status(500).json({ erro: 'Erro ao listar pastas do Drive: ' + e.message });
  }
});

// Lista o conteudo de uma pasta especifica (subpastas e arquivos)
app.get('/admin/drives/:pastaId', autenticar, somenteAdmin, async (req, res) => {
  try {
    const oauth = await clientComTokens();
    if (!oauth) return res.status(400).json({ erro: 'Google Drive nao conectado.' });
    const drive = google.drive({ version: 'v3', auth: oauth });

    const resultado = await drive.files.list({
      q: `'${req.params.pastaId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, size, md5Checksum)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const itens = (resultado.data.files || []).map((f) => ({
      id: f.id,
      nome: f.name,
      pasta: f.mimeType === 'application/vnd.google-apps.folder',
      tamanho: f.size ? Number(f.size) : null,
      md5: f.md5Checksum || null,
    }));

    res.json({ ok: true, itens });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao listar pasta: ' + e.message });
  }
});

// ============ ROTAS PROTEGIDAS ============
app.get('/api/me', autenticar, (req, res) => {
  res.json({ ok: true, usuario: req.usuario, admin: ADMIN_EMAILS.length === 0 || ADMIN_EMAILS.includes(req.usuario.email) });
});

// ============ START ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('Rodando na porta ' + PORT);
});
