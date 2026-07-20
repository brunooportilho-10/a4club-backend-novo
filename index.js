const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://a4club-frontend1-production.up.railway.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://a4club-backend-novo-production.up.railway.app';
const REDIRECT_URI = BACKEND_URL + '/auth/google/callback';

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

// ============ CLOUDFLARE R2 ============
let r2 = null;
let r2Ok = false;
const R2_BUCKET = process.env.STORAGE_BUCKET || '';
try {
  if (process.env.STORAGE_ENDPOINT && process.env.STORAGE_ACCESS_KEY_ID) {
    r2 = new S3Client({
      region: process.env.STORAGE_REGION || 'auto',
      endpoint: process.env.STORAGE_ENDPOINT,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
      },
    });
    r2Ok = true;
    console.log('Cloudflare R2 configurado. Bucket: ' + R2_BUCKET);
  } else {
    console.log('AVISO: variaveis do R2 nao configuradas');
  }
} catch (e) {
  console.log('ERRO ao configurar R2: ' + e.message);
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

async function clientComTokens() {
  if (!db) return null;
  const doc = await db.collection('config').doc('google_tokens').get();
  if (!doc.exists) return null;
  const oauth = novoOAuthClient();
  oauth.setCredentials(doc.data().tokens);
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
  if (ADMIN_EMAILS.length === 0) return next();
  if (ADMIN_EMAILS.includes(req.usuario.email)) return next();
  return res.status(403).json({ erro: 'Acesso restrito ao administrador' });
}

// ============ ROTAS PUBLICAS ============
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'A4 CLUB Backend Online!',
    firebase: firebaseOk,
    r2: r2Ok,
    versao: 'etapa-3',
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ============ AUTENTICACAO GOOGLE (Drive) ============
app.get('/auth/google', (req, res) => {
  const oauth = novoOAuthClient();
  const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  res.redirect(url);
});

app.get('/admin/auth/google', autenticar, somenteAdmin, (req, res) => {
  const oauth = novoOAuthClient();
  const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  res.json({ ok: true, url });
});

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
app.get('/admin/drives', autenticar, somenteAdmin, async (req, res) => {
  try {
    const oauth = await clientComTokens();
    if (!oauth) {
      return res.status(400).json({ erro: 'Google Drive nao conectado. Conecte primeiro.', conectado: false });
    }
    const drive = google.drive({ version: 'v3', auth: oauth });

    const raiz = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false",
      fields: 'files(id, name)',
      pageSize: 100,
    });

    const compartilhadas = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and sharedWithMe=true and trashed=false",
      fields: 'files(id, name, owners(displayName, emailAddress))',
      pageSize: 100,
    });

    let sharedDrives = [];
    try {
      const sd = await drive.drives.list({ pageSize: 50 });
      sharedDrives = (sd.data.drives || []).map((d) => ({ id: d.id, nome: d.name, tipo: 'shared_drive' }));
    } catch (e) { /* conta sem shared drives */ }

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

// ============ MOTOR DE IMPORTACAO (Drive -> R2) ============
const jobAtivo = { id: null, pausado: false, cancelado: false };
const CONCORRENCIA = 3;

function extensao(nome) {
  const i = nome.lastIndexOf('.');
  return i >= 0 ? nome.slice(i + 1).toLowerCase() : '';
}

// Limpa prefixos comuns do nome do Drive para virar um nome de categoria bonito
// Ex: "DV - Arquivos de Corte" -> "Arquivos de Corte"
function nomeCategoria(nomeDrive) {
  return nomeDrive.replace(/^DV\s*-\s*/i, '').trim();
}

async function listarRecursivo(drive, pastaId, caminho, lista, nivel) {
  if (nivel > 10) return;
  let pageToken = null;
  do {
    const resp = await drive.files.list({
      q: `'${pastaId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, md5Checksum)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of resp.data.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        await listarRecursivo(drive, f.id, caminho + '/' + f.name, lista, nivel + 1);
      } else {
        lista.push({
          driveId: f.id,
          nome: f.name,
          mime: f.mimeType,
          tamanho: f.size ? Number(f.size) : 0,
          md5: f.md5Checksum || null,
          caminho,
        });
      }
    }
    pageToken = resp.data.nextPageToken;
  } while (pageToken);
}

async function atualizarJob(jobId, dados) {
  await db.collection('jobs').doc(jobId).set(
    { ...dados, atualizadoEm: new Date().toISOString() },
    { merge: true }
  );
}

async function processarArquivo(drive, arq, categoriaFixa, contadores, errosLog) {
  try {
    if (!arq.md5) {
      contadores.pulados++;
      return; // arquivos nativos do Google (Docs/Sheets) - fora do escopo
    }

    const docRef = db.collection('arquivos').doc(arq.md5);
    const existente = await docRef.get();
    if (existente.exists) {
      contadores.pulados++;
      return;
    }

    const resp = await drive.files.get(
      { fileId: arq.driveId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    const r2Key = 'arquivos/' + arq.md5 + '/' + arq.nome;
    const upload = new Upload({
      client: r2,
      params: {
        Bucket: R2_BUCKET,
        Key: r2Key,
        Body: resp.data,
        ContentType: arq.mime || 'application/octet-stream',
      },
    });
    await upload.done();

    // categoria = o Drive/pasta que foi sincronizada (fixa para o job inteiro)
    // colecao = a subpasta logo abaixo dela (normalmente o nome do estudio/artista)
    const partes = arq.caminho.split('/').filter(Boolean);
    const colecao = partes.length > 1 ? partes[1] : null;

    await docRef.set({
      nome: arq.nome,
      nomeBusca: arq.nome.toLowerCase(),
      md5: arq.md5,
      tamanho: arq.tamanho,
      mime: arq.mime,
      extensao: extensao(arq.nome),
      categoria: categoriaFixa,
      colecao,
      caminho: arq.caminho,
      r2Key,
      driveId: arq.driveId,
      importadoEm: new Date().toISOString(),
      downloads: 0,
    });

    // Registra/atualiza a categoria numa colecao propria, para o catalogo
    // sempre listar TODAS as categorias existentes (nao so as dos arquivos recentes)
    await db.collection('categorias').doc(categoriaFixa).set({
      nome: categoriaFixa,
      total: admin.firestore.FieldValue.increment(1),
      atualizadoEm: new Date().toISOString(),
    }, { merge: true });

    contadores.importados++;
  } catch (e) {
    contadores.erros++;
    if (errosLog.length < 20) errosLog.push(arq.nome + ': ' + e.message);
    console.log('Erro no arquivo ' + arq.nome + ': ' + e.message);
  }
}

async function executarJob(jobId, pastaId, pastaNome) {
  const contadores = { importados: 0, pulados: 0, erros: 0, processados: 0 };
  const errosLog = [];
  const categoriaFixa = nomeCategoria(pastaNome);
  try {
    const oauth = await clientComTokens();
    if (!oauth) throw new Error('Google Drive nao conectado');
    const drive = google.drive({ version: 'v3', auth: oauth });

    await atualizarJob(jobId, { status: 'listando', mensagem: 'Varrendo pastas do Drive...' });

    const lista = [];
    await listarRecursivo(drive, pastaId, pastaNome, lista, 0);

    await atualizarJob(jobId, {
      status: 'executando',
      total: lista.length,
      mensagem: 'Importando arquivos...',
    });

    let indice = 0;
    async function trabalhador() {
      while (indice < lista.length) {
        if (jobAtivo.cancelado) return;
        while (jobAtivo.pausado) {
          await new Promise((r) => setTimeout(r, 2000));
          if (jobAtivo.cancelado) return;
        }
        const meuIndice = indice++;
        if (meuIndice >= lista.length) return;
        const arq = lista[meuIndice];
        await processarArquivo(drive, arq, categoriaFixa, contadores, errosLog);
        contadores.processados++;
        if (contadores.processados % 10 === 0 || contadores.processados === lista.length) {
          await atualizarJob(jobId, { ...contadores, errosLog });
        }
      }
    }

    const trabalhadores = [];
    for (let i = 0; i < CONCORRENCIA; i++) trabalhadores.push(trabalhador());
    await Promise.all(trabalhadores);

    const statusFinal = jobAtivo.cancelado ? 'cancelado' : 'concluido';
    await atualizarJob(jobId, {
      ...contadores,
      errosLog,
      status: statusFinal,
      mensagem: statusFinal === 'concluido'
        ? `Concluido: ${contadores.importados} importados, ${contadores.pulados} pulados, ${contadores.erros} erros`
        : 'Importacao cancelada',
      finalizadoEm: new Date().toISOString(),
    });
  } catch (e) {
    console.log('Erro no job ' + jobId + ': ' + e.message);
    await atualizarJob(jobId, {
      ...contadores,
      status: 'erro',
      mensagem: e.message,
      finalizadoEm: new Date().toISOString(),
    });
  } finally {
    jobAtivo.id = null;
    jobAtivo.pausado = false;
    jobAtivo.cancelado = false;
  }
}

app.post('/admin/importar', autenticar, somenteAdmin, async (req, res) => {
  try {
    const { driveId, driveNome } = req.body;
    if (!driveId) return res.status(400).json({ erro: 'driveId obrigatorio' });
    if (!r2Ok) return res.status(400).json({ erro: 'R2 nao configurado' });
    if (jobAtivo.id) return res.status(409).json({ erro: 'Ja existe uma importacao em andamento', jobId: jobAtivo.id });

    const jobRef = db.collection('jobs').doc();
    const jobId = jobRef.id;
    await jobRef.set({
      pastaId: driveId,
      pastaNome: driveNome || 'Sem nome',
      status: 'iniciando',
      total: 0,
      processados: 0,
      importados: 0,
      pulados: 0,
      erros: 0,
      iniciadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
    });

    jobAtivo.id = jobId;
    jobAtivo.pausado = false;
    jobAtivo.cancelado = false;

    executarJob(jobId, driveId, driveNome || 'Sem nome');

    res.json({ ok: true, jobId });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/admin/job/:jobId', autenticar, somenteAdmin, async (req, res) => {
  try {
    const doc = await db.collection('jobs').doc(req.params.jobId).get();
    if (!doc.exists) return res.status(404).json({ erro: 'Job nao encontrado' });
    const job = { id: doc.id, ...doc.data() };
    if ((job.status === 'executando' || job.status === 'listando' || job.status === 'iniciando') && jobAtivo.id !== job.id) {
      job.status = 'interrompido';
      job.mensagem = 'Servidor reiniciou durante a importacao. Clique em Sincronizar novamente (arquivos ja importados serao pulados).';
    }
    res.json({ ok: true, job });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/admin/job/:jobId/pausar', autenticar, somenteAdmin, async (req, res) => {
  if (jobAtivo.id !== req.params.jobId) return res.status(400).json({ erro: 'Este job nao esta em execucao' });
  jobAtivo.pausado = true;
  await atualizarJob(req.params.jobId, { status: 'pausado', mensagem: 'Pausado pelo administrador' });
  res.json({ ok: true });
});

app.post('/admin/job/:jobId/retomar', autenticar, somenteAdmin, async (req, res) => {
  if (jobAtivo.id !== req.params.jobId) return res.status(400).json({ erro: 'Este job nao esta em execucao (use Sincronizar de novo)' });
  jobAtivo.pausado = false;
  await atualizarJob(req.params.jobId, { status: 'executando', mensagem: 'Retomado' });
  res.json({ ok: true });
});

app.get('/admin/jobs', autenticar, somenteAdmin, async (req, res) => {
  try {
    const snap = await db.collection('jobs').orderBy('iniciadoEm', 'desc').limit(10).get();
    const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, jobs });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/admin/stats', autenticar, somenteAdmin, async (req, res) => {
  try {
    const agg = await db.collection('arquivos').count().get();
    let totalUsuarios = 0;
    try {
      const u = await db.collection('usuarios').count().get();
      totalUsuarios = u.data().count;
    } catch (e) { /* colecao ainda nao existe */ }
    res.json({
      ok: true,
      totalArquivos: agg.data().count,
      totalUsuarios,
      importacaoAtiva: jobAtivo.id,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ============ CATALOGO ============
app.get('/api/catalogo/home', autenticar, async (req, res) => {
  try {
    const recentes = await db.collection('arquivos').orderBy('importadoEm', 'desc').limit(24).get();
    const arquivos = recentes.docs.map((d) => {
      const a = d.data();
      return {
        id: d.id, nome: a.nome, categoria: a.categoria, colecao: a.colecao || null,
        extensao: a.extensao, tamanho: a.tamanho, importadoEm: a.importadoEm,
      };
    });

    const catsSnap = await db.collection('categorias').orderBy('nome').get();
    const categorias = catsSnap.docs.map((d) => ({
      nome: d.data().nome,
      total: d.data().total || 0,
    }));

    res.json({ ok: true, arquivos, categorias });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/catalogo/categoria/:nome', autenticar, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 200);
    const snap = await db.collection('arquivos')
      .where('categoria', '==', req.params.nome)
      .limit(limit)
      .get();
    const arquivos = snap.docs.map((d) => {
      const a = d.data();
      return {
        id: d.id, nome: a.nome, categoria: a.categoria, colecao: a.colecao || null,
        extensao: a.extensao, tamanho: a.tamanho, importadoEm: a.importadoEm,
      };
    });
    res.json({ ok: true, arquivos });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/catalogo/buscar', autenticar, async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const limit = Math.min(Number(req.query.limit || 20), 50);
    if (!q) return res.json({ ok: true, arquivos: [] });
    const snap = await db.collection('arquivos')
      .orderBy('nomeBusca')
      .startAt(q)
      .endAt(q + '\uf8ff')
      .limit(limit)
      .get();
    const arquivos = snap.docs.map((d) => {
      const a = d.data();
      return { id: d.id, nome: a.nome, categoria: a.categoria, colecao: a.colecao || null, extensao: a.extensao, tamanho: a.tamanho };
    });
    res.json({ ok: true, arquivos });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/catalogo/arquivo/:id/download', autenticar, async (req, res) => {
  try {
    const doc = await db.collection('arquivos').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ erro: 'Arquivo nao encontrado' });
    const a = doc.data();
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: a.r2Key,
        ResponseContentDisposition: `attachment; filename="${a.nome.replace(/"/g, '')}"`,
      }),
      { expiresIn: 600 }
    );
    doc.ref.set({ downloads: (a.downloads || 0) + 1 }, { merge: true });
    res.json({ ok: true, url, nome: a.nome });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ============ ROTAS PROTEGIDAS ============
app.get('/api/me', autenticar, (req, res) => {
  res.json({
    ok: true,
    usuario: req.usuario,
    admin: ADMIN_EMAILS.length === 0 || ADMIN_EMAILS.includes(req.usuario.email),
  });
});

// ============ START ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('Rodando na porta ' + PORT);
});
