# A4 CLUB - Backend Express Simples

Backend minimalista para A4 CLUB com autenticação, importação do Google Drive e armazenamento no Cloudflare R2.

## Requisitos

- Node.js 18+
- PostgreSQL
- Cloudflare R2 (S3-compatible storage)
- Google OAuth credentials

## Instalação

```bash
npm install
```

## Variáveis de Ambiente

Crie um arquivo `.env` com:

```
DATABASE_URL=postgresql://user:password@localhost:5432/a4club
PORT=3000
GOOGLE_CLIENT_ID=seu-client-id
GOOGLE_CLIENT_SECRET=seu-client-secret
APP_URL=http://localhost:3000
STORAGE_ENDPOINT=https://seu-account.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY_ID=seu-access-key
STORAGE_SECRET_ACCESS_KEY=seu-secret-key
STORAGE_BUCKET=a4club-arquivos
JWT_SECRET=seu-secret-token
```

## Executar

```bash
npm start        # Produção
npm run dev      # Desenvolvimento
```

## Endpoints

### Auth
- `POST /auth/login` - Login
- `POST /auth/register` - Registrar usuário
- `GET /auth/google-auth` - Obter URL autenticação Google

### Import
- `POST /import/files` - Listar arquivos Google Drive
- `POST /import/import-file` - Importar arquivo

### Files
- `GET /files/list` - Listar arquivos
- `POST /files/upload` - Fazer upload para R2
- `GET /files/download/:fileId` - Download arquivo

### Health
- `GET /health` - Status do backend

## Estrutura

```
src/
├── server.js          # Express app
├── db.js              # PostgreSQL
├── routes/
│   ├── auth.js        # Autenticação
│   ├── import.js      # Google Drive
│   └── files.js       # R2 Storage
package.json
README.md
```
