#!/bin/sh
set -e

echo "🚚 RotaCerta backend inicializando..."

# Espera Postgres ficar disponível
until node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(() => c.end()).catch(() => process.exit(1));
" 2>/dev/null; do
  echo "⏳ Aguardando PostgreSQL..."
  sleep 2
done
echo "✅ PostgreSQL disponível"

# Aplica migrations (idempotente)
echo "📦 Aplicando migrations..."
npx prisma migrate deploy || npx prisma db push

# Seed inicial (roda apenas se SEED_ON_START=true e não há usuários)
if [ "$SEED_ON_START" = "true" ]; then
  echo "🌱 Verificando necessidade de seed..."
  node -e "
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    p.user.count().then(c => {
      if (c === 0) {
        console.log('Base vazia, executando seed...');
        require('child_process').execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
      } else {
        console.log('Já existem ' + c + ' usuários, pulando seed.');
      }
    }).catch(e => { console.error(e); process.exit(0); });
  " || echo "⚠️  Seed pulado"
fi

echo "🚀 Iniciando servidor..."
exec node dist/server.js
