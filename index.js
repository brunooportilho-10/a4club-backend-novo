const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
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

function ehAdminEmail(email) {
  return ADMIN_EMAILS.length === 0 || ADMIN_EMAILS.includes(email);
}

// Bloqueia o acesso ao catalogo para quem nao esta com assinatura 'pago'.
// Admins sempre passam. Usuario novo eh criado automaticamente como 'pendente'.
async function verificarAssinatura(req, res, next) {
  if (ehAdminEmail(req.usuario.email)) return next();
  try {
    const ref = db.collection('usuarios').doc(req.usuario.uid);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set({
        email: req.usuario.email,
        status: 'pendente',
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
      });
      return res.status(403).json({
        erro: 'Seu acesso ainda nao foi liberado. Entre em contato com o administrador do A4 CLUB.',
        status: 'pendente',
      });
    }
    const status = doc.data().status || 'pendente';
    if (status !== 'pago') {
      return res.status(403).json({
        erro: 'Seu acesso esta bloqueado. Entre em contato com o administrador do A4 CLUB.',
        status,
      });
    }
    next();
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
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

function safeId(str) {
  return String(str).replace(/[\/\s]+/g, '_').slice(0, 120);
}

function mapArquivo(doc) {
  const a = doc.data();
  return {
    id: doc.id,
    nome: a.nome,
    categoria: a.categoria,
    colecao: a.colecao || null,
    pastaPai: a.pastaPai || '',
    extensao: a.extensao,
    tamanho: a.tamanho,
    importadoEm: a.importadoEm,
  };
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

// Registra cada nivel da cadeia de pastas (ex: "Lina Criativa/Cartao Sus 1/- Porta Chaveirinho")
// como um no navegavel na colecao 'pastas', igual a estrutura real do Drive.
// pastasRegistradas eh um Set compartilhado no job inteiro, para nao escrever o mesmo no varias vezes.
async function registrarCadeiaPastas(categoria, pastaRelativa, pastasRegistradas) {
  if (!pastaRelativa) return;
  const segmentos = pastaRelativa.split('/').filter(Boolean);
  let acumulado = '';
  for (const seg of segmentos) {
    const pai = acumulado;
    acumulado = acumulado ? acumulado + '/' + seg : seg;
    const pastaId = safeId(categoria) + '__' + safeId(acumulado);
    if (pastasRegistradas.has(pastaId)) continue;
    pastasRegistradas.add(pastaId);
    await db.collection('pastas').doc(pastaId).set({
      categoria,
      caminho: acumulado,
      nome: seg,
      pai,
    }, { merge: true });
  }
}

async function processarArquivo(drive, arq, categoriaFixa, contadores, errosLog, pastasRegistradas) {
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
    // pastaPai = TODO o caminho de subpastas ate o arquivo, igual a estrutura do Drive
    // (ex: "Lina Criativa/Cartao Sus 1/- Porta Chaveirinho")
    const partes = arq.caminho.split('/').filter(Boolean);
    const pastaPai = partes.slice(1).join('/'); // remove o 1o segmento (nome cru da pasta raiz)
    const colecao = partes.length > 1 ? partes[1] : null; // mantido para compatibilidade

    await docRef.set({
      nome: arq.nome,
      nomeBusca: arq.nome.toLowerCase(),
      md5: arq.md5,
      tamanho: arq.tamanho,
      mime: arq.mime,
      extensao: extensao(arq.nome),
      categoria: categoriaFixa,
      pastaPai,
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

    // Registra TODOS os niveis da arvore de pastas, igual ao Drive
    await registrarCadeiaPastas(categoriaFixa, pastaPai, pastasRegistradas);

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
  const pastasRegistradas = new Set(); // evita reescrever a mesma pasta varias vezes no job
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
        await processarArquivo(drive, arq, categoriaFixa, contadores, errosLog, pastasRegistradas);
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

// Apaga TODO o catalogo (Firestore + R2) para recomecar a importacao do zero.
// Usar apos corrigir a logica de categorizacao, para nao deixar arquivos com categoria antiga.
app.post('/admin/reset', autenticar, somenteAdmin, async (req, res) => {
  if (req.body.confirmar !== 'LIMPAR TUDO') {
    return res.status(400).json({ erro: 'Confirmacao invalida. Envie confirmar: "LIMPAR TUDO"' });
  }
  if (jobAtivo.id) {
    return res.status(409).json({ erro: 'Ha uma importacao em andamento. Aguarde ou pause antes de limpar.' });
  }
  try {
    let apagadosFirestore = 0;
    // Apaga em lotes a colecao "arquivos"
    let continuar = true;
    while (continuar) {
      const snap = await db.collection('arquivos').limit(400).get();
      if (snap.empty) { continuar = false; break; }
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      apagadosFirestore += snap.size;
    }
    // Apaga a colecao "categorias"
    const catsSnap = await db.collection('categorias').get();
    if (!catsSnap.empty) {
      const batch = db.batch();
      catsSnap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // Apaga a colecao "colecoes" (estudios)
    const colsSnap = await db.collection('colecoes').get();
    if (!colsSnap.empty) {
      const batch = db.batch();
      colsSnap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // Apaga a colecao "pastas" (arvore de navegacao)
    const pastasSnapReset = await db.collection('pastas').get();
    if (!pastasSnapReset.empty) {
      const batch = db.batch();
      pastasSnapReset.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // Apaga os objetos do R2 (prefixo "arquivos/")
    let apagadosR2 = 0;
    let continuationToken = undefined;
    do {
      const listados = await r2.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: 'arquivos/',
        ContinuationToken: continuationToken,
      }));
      const objetos = (listados.Contents || []).map((o) => ({ Key: o.Key }));
      if (objetos.length > 0) {
        await r2.send(new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: objetos },
        }));
        apagadosR2 += objetos.length;
      }
      continuationToken = listados.IsTruncated ? listados.NextContinuationToken : undefined;
    } while (continuationToken);

    res.json({ ok: true, apagadosFirestore, apagadosR2 });
  } catch (e) {
    console.log('Erro no reset: ' + e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Recalcula categorias, colecoes E a arvore completa de pastas (pastaPai em cada
// arquivo + colecao 'pastas') a partir do campo 'caminho' ja salvo nos arquivos.
// Nao baixa nada do Drive de novo - so reorganiza o que ja esta no Firestore.
app.post('/admin/backfill-colecoes', autenticar, somenteAdmin, async (req, res) => {
  try {
    const contagemCategoria = {};
    const contagemColecao = {};
    const pastasRegistradas = new Set();
    let totalProcessados = 0;
    let ultimoDoc = null;

    while (true) {
      let query = db.collection('arquivos').orderBy(admin.firestore.FieldPath.documentId()).limit(300);
      if (ultimoDoc) query = query.startAfter(ultimoDoc);
      const pagina = await query.get();
      if (pagina.empty) break;

      const batch = db.batch();
      for (const doc of pagina.docs) {
        const a = doc.data();
        if (!a.categoria || !a.caminho) continue;

        const partes = String(a.caminho).split('/').filter(Boolean);
        const pastaPai = partes.slice(1).join('/');
        const colecao = partes.length > 1 ? partes[1] : null;

        // Atualiza o arquivo com pastaPai, se ainda nao tiver
        if (a.pastaPai === undefined || a.pastaPai !== pastaPai) {
          batch.set(doc.ref, { pastaPai, colecao }, { merge: true });
        }

        contagemCategoria[a.categoria] = (contagemCategoria[a.categoria] || 0) + 1;
        if (colecao) {
          const key = safeId(a.categoria) + '__' + safeId(colecao);
          if (!contagemColecao[key]) contagemColecao[key] = { categoria: a.categoria, colecao, total: 0 };
          contagemColecao[key].total++;
        }

        // Registra a arvore inteira de pastas (todos os niveis)
        if (pastaPai) {
          const segmentos = pastaPai.split('/').filter(Boolean);
          let acumulado = '';
          for (const seg of segmentos) {
            const pai = acumulado;
            acumulado = acumulado ? acumulado + '/' + seg : seg;
            const pastaId = safeId(a.categoria) + '__' + safeId(acumulado);
            if (pastasRegistradas.has(pastaId)) continue;
            pastasRegistradas.add(pastaId);
            batch.set(
              db.collection('pastas').doc(pastaId),
              { categoria: a.categoria, caminho: acumulado, nome: seg, pai },
              { merge: true }
            );
          }
        }

        totalProcessados++;
      }
      await batch.commit();

      ultimoDoc = pagina.docs[pagina.docs.length - 1];
      if (pagina.size < 300) break;
    }

    const catEntradas = Object.entries(contagemCategoria);
    for (let i = 0; i < catEntradas.length; i += 400) {
      const batch = db.batch();
      catEntradas.slice(i, i + 400).forEach(([nome, total]) => {
        batch.set(
          db.collection('categorias').doc(nome),
          { nome, total, atualizadoEm: new Date().toISOString() },
          { merge: true }
        );
      });
      await batch.commit();
    }

    const colEntradas = Object.entries(contagemColecao);
    for (let i = 0; i < colEntradas.length; i += 400) {
      const batch = db.batch();
      colEntradas.slice(i, i + 400).forEach(([id, dados]) => {
        batch.set(
          db.collection('colecoes').doc(id),
          { ...dados, atualizadoEm: new Date().toISOString() },
          { merge: true }
        );
      });
      await batch.commit();
    }

    res.json({
      ok: true,
      totalArquivos: totalProcessados,
      categorias: catEntradas.length,
      colecoes: colEntradas.length,
      pastas: pastasRegistradas.size,
    });
  } catch (e) {
    console.log('Erro no backfill: ' + e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Relatorio de assinantes: todos que ja fizeram login (e portanto tem doc 'usuarios')
app.get('/admin/usuarios', autenticar, somenteAdmin, async (req, res) => {
  try {
    const snap = await db.collection('usuarios').orderBy('criadoEm', 'desc').get();
    const usuarios = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    res.json({ ok: true, usuarios });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Marca um assinante como pago / pendente / bloqueado
app.post('/admin/usuarios/:uid/status', autenticar, somenteAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pago', 'pendente', 'bloqueado'].includes(status)) {
      return res.status(400).json({ erro: 'Status invalido' });
    }
    await db.collection('usuarios').doc(req.params.uid).set(
      { status, atualizadoEm: new Date().toISOString() },
      { merge: true }
    );
    res.json({ ok: true });
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

    // Espaco usado no R2 = soma do tamanho de todos os arquivos ja importados.
    // Tenta a agregacao nativa do Firestore (rapida); se nao suportada, soma manualmente.
    let espacoUsadoBytes = 0;
    try {
      const somaSnap = await db.collection('arquivos')
        .aggregate({ totalBytes: admin.firestore.AggregateField.sum('tamanho') })
        .get();
      espacoUsadoBytes = somaSnap.data().totalBytes || 0;
    } catch (e) {
      const todosSnap = await db.collection('arquivos').select('tamanho').get();
      espacoUsadoBytes = todosSnap.docs.reduce((acc, d) => acc + (d.data().tamanho || 0), 0);
    }

    res.json({
      ok: true,
      totalArquivos: agg.data().count,
      totalUsuarios,
      importacaoAtiva: jobAtivo.id,
      espacoUsadoBytes,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ============ CATALOGO ============
app.get('/api/catalogo/home', autenticar, verificarAssinatura, async (req, res) => {
  try {
    const recentes = await db.collection('arquivos').orderBy('importadoEm', 'desc').limit(10).get();
    const arquivos = recentes.docs.map(mapArquivo);

    const catsSnap = await db.collection('categorias').get();
    const categorias = catsSnap.docs
      .map((d) => ({ nome: d.data().nome, total: d.data().total || 0 }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));

    // Estatisticas reais para os cards do topo
    const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [totalArquivosSnap, novosSemanaSnap, globalSnap] = await Promise.all([
      db.collection('arquivos').count().get(),
      db.collection('arquivos').where('importadoEm', '>=', seteDiasAtras).count().get(),
      db.collection('stats').doc('global').get(),
    ]);

    const stats = {
      totalArquivos: totalArquivosSnap.data().count,
      totalCategorias: categorias.length,
      novosSemana: novosSemanaSnap.data().count,
      totalDownloads: globalSnap.exists ? globalSnap.data().totalDownloads || 0 : 0,
    };

    res.json({ ok: true, arquivos, categorias, stats });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Lista os "estudios" (subpastas) dentro de uma categoria - como navegar pastas do Drive
// Navegacao genérica por pastas, em qualquer profundidade - igual ao Drive.
// caminho='' = raiz da categoria. caminho='Lina Criativa/Cartao Sus 1' = dentro dessa subpasta.
app.get('/api/catalogo/navegar', autenticar, verificarAssinatura, async (req, res) => {
  try {
    const categoria = String(req.query.categoria || '');
    const caminho = String(req.query.caminho || '');
    if (!categoria) return res.status(400).json({ erro: 'categoria obrigatoria' });

    const [pastasSnap, arquivosSnap] = await Promise.all([
      db.collection('pastas').where('categoria', '==', categoria).where('pai', '==', caminho).get(),
      db.collection('arquivos').where('categoria', '==', categoria).where('pastaPai', '==', caminho).limit(300).get(),
    ]);

    const subpastas = pastasSnap.docs
      .map((d) => ({ nome: d.data().nome, caminho: d.data().caminho }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));

    const arquivos = arquivosSnap.docs
      .map(mapArquivo)
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));

    res.json({ ok: true, subpastas, arquivos });
  } catch (e) {
    console.log('Erro ao navegar: ' + e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/catalogo/categoria/:nome/colecoes', autenticar, verificarAssinatura, async (req, res) => {
  try {
    const snap = await db.collection('colecoes')
      .where('categoria', '==', req.params.nome)
      .get();
    const colecoes = snap.docs
      .map((d) => ({ nome: d.data().colecao, total: d.data().total || 0 }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));

    const soltosCount = await db.collection('arquivos')
      .where('categoria', '==', req.params.nome)
      .where('colecao', '==', null)
      .count()
      .get();

    res.json({ ok: true, colecoes, totalSoltos: soltosCount.data().count });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Arquivos de UM estudio especifico dentro da categoria
app.get('/api/catalogo/categoria/:nome/estudio/:colecao', autenticar, verificarAssinatura, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 300), 500);
    const snap = await db.collection('arquivos')
      .where('categoria', '==', req.params.nome)
      .where('colecao', '==', req.params.colecao)
      .limit(limit)
      .get();
    const arquivos = snap.docs.map(mapArquivo).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));
    res.json({ ok: true, arquivos });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Arquivos soltos direto na categoria (sem subpasta de estudio)
app.get('/api/catalogo/categoria/:nome/soltos', autenticar, verificarAssinatura, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 300), 500);
    const snap = await db.collection('arquivos')
      .where('categoria', '==', req.params.nome)
      .where('colecao', '==', null)
      .limit(limit)
      .get();
    const arquivos = snap.docs.map(mapArquivo).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));
    res.json({ ok: true, arquivos });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Todos os arquivos de uma categoria, sem separar por estudio (uso geral/compatibilidade)
app.get('/api/catalogo/categoria/:nome', autenticar, verificarAssinatura, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 300);
    const snap = await db.collection('arquivos')
      .where('categoria', '==', req.params.nome)
      .limit(limit)
      .get();
    const arquivos = snap.docs.map(mapArquivo).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));
    res.json({ ok: true, arquivos });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/catalogo/buscar', autenticar, verificarAssinatura, async (req, res) => {
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
    res.json({ ok: true, arquivos: snap.docs.map(mapArquivo) });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/catalogo/arquivo/:id/download', autenticar, verificarAssinatura, async (req, res) => {
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
    db.collection('stats').doc('global').set(
      { totalDownloads: admin.firestore.FieldValue.increment(1) },
      { merge: true }
    );
    res.json({ ok: true, url, nome: a.nome });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Link temporario para VISUALIZAR o arquivo (imagem ou PDF) sem forcar download
// e sem contar como download. Usado pelas miniaturas e pelo botao de previa.
app.get('/api/catalogo/arquivo/:id/preview', autenticar, verificarAssinatura, async (req, res) => {
  try {
    const doc = await db.collection('arquivos').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ erro: 'Arquivo nao encontrado' });
    const a = doc.data();
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: a.r2Key }),
      { expiresIn: 600 }
    );
    res.json({ ok: true, url, mime: a.mime, extensao: a.extensao });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ============ ROTAS PROTEGIDAS ============
app.get('/api/me', autenticar, async (req, res) => {
  const souAdmin = ehAdminEmail(req.usuario.email);
  let statusAssinatura = 'pago'; // admins sempre liberados

  if (!souAdmin) {
    try {
      const ref = db.collection('usuarios').doc(req.usuario.uid);
      const doc = await ref.get();
      if (!doc.exists) {
        await ref.set({
          email: req.usuario.email,
          status: 'pendente',
          criadoEm: new Date().toISOString(),
          atualizadoEm: new Date().toISOString(),
        });
        statusAssinatura = 'pendente';
      } else {
        statusAssinatura = doc.data().status || 'pendente';
      }
    } catch (e) {
      statusAssinatura = 'pendente';
    }
  }

  res.json({
    ok: true,
    usuario: req.usuario,
    admin: souAdmin,
    statusAssinatura,
  });
});

// ============ START ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('Rodando na porta ' + PORT);
});
