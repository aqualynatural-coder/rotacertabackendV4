# 🚚 RotaCerta v4 — Gestão de Entregas em Tempo Real (PWA Full-Stack)

Sistema completo de logística last-mile: escritório acompanha tudo ao vivo, motorista opera com 2 toques — **independente de APIs pagas** (OpenStreetMap + lógica matemática própria).

## ⭐ Novidades da v4

| Recurso | Como funciona |
|---|---|
| 🏢 **Expediente automático (geofence da sede)** | Cadastre o endereço da empresa em *Personalização*. Ao entrar na área, o app registra o início do dia **sozinho**; ao voltar sem entregas pendentes, encerra — com celebração visual + som 🌅🏁 |
| 💬 **Chat escritório ↔ motorista** | Tempo real via Socket.IO, persistente, com badge de não lidas e som. 100% próprio, sem WhatsApp |
| 🗺️ **Otimizador de rota** | Reordena entregas minimizando km (nearest neighbor a partir da sede) — 1 clique no detalhe da rota |
| 📍 **Chegada automática em entregas** | Geofence de 60m marca "ARRIVED" sozinho quando o motorista chega ao cliente |
| 🔔 **Web Push** | Notificação mesmo com o app fechado (VAPID + service worker) |
| 🔗 **Link público de rastreamento** | Cliente acompanha a rota ao vivo em `/rastreio/:token` — sem login, expira em 48–72h, revogável |
| 🔥 **Mapa de calor** | Zonas quentes da operação (leaflet.heat) — 7/30/90 dias |
| 📄 **Exportação oficial** | CSV (Excel pt-BR) + PDF executivo gerados no servidor |
| 🔐 **2FA (TOTP)** | Google Authenticator/Authy para admins — ative em *Segurança* |
| 🛡️ **Anti-spoof GPS** | Detecta teleporte, velocidade impossível e precisão falsa; marca ping como suspeito |
| 🎤 **Comando de voz** | "cheguei" / "confirmar entrega" / "registrar falha" (Web Speech API, pt-BR) |
| 📷 **OCR do recibo** | Lê texto da foto de prova (Tesseract.js, português) e sugere nas observações |
| 🌐 **i18n** | Dicionário pt-BR / es / en pronto (react-i18next) |
| 🧪 **Qualidade** | Vitest (lógica pura) + Playwright E2E + CI/CD GitHub Actions |
| 📱 **Capacitor** | Mesma codebase vira app Android nativo (`npx cap add android`) |

## 🏗️ Stack

- **Backend**: Node 20 + Express + TypeScript + Prisma + PostgreSQL + Socket.IO (19 módulos de rota)
- **Frontend**: React 18 + Vite + Tailwind + Leaflet + React Query + Zustand + Dexie (offline)
- **PWA**: Service worker custom (injectManifest) — precache, cache de tiles/fontes, NetworkFirst p/ API, **push notifications**
- **Lógica pura**: Haversine, TSP nearest-neighbor, combustível, atraso, manutenção, anti-spoof — sem IA, sem API paga

## 🚀 Quick start

```bash
docker compose -f docker-compose.prod.yml up -d --build
# Seed (cria admin/motorista demo + sede demo na Paulista):
docker compose -f docker-compose.prod.yml exec backend npx tsx prisma/seed.ts
```

- Admin: `admin@rotacerta.app` / `admin123`
- Motorista: `motorista@rotacerta.app` / `motorista123`

## ⚙️ Configurações importantes (.env do backend)

```
DATABASE_URL=postgresql://...
JWT_SECRET=troque-este-segredo
# Web Push — gere com: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

## 📋 Pós-instalação (3 passos)

1. **Personalização** → suba logo, escolha a cor e **defina a sede no mapa** (ativa o expediente automático)
2. **Segurança** → ative o 2FA do admin
3. **Configurações** → exclua as contas demo com 1 clique

## 🧪 Testes

```bash
cd backend && npm run test        # unitários (lógica pura)
cd frontend && npm run test:e2e   # E2E (requer app rodando)
```

## 📱 App nativo (opcional)

```bash
cd frontend && npm run build && npx cap add android && npx cap sync && npx cap open android
```

## 📁 Estrutura

```
backend/   → 19 rotas REST + sockets (chat, GPS, geofences) + lógica pura + testes
frontend/  → 22 telas (13 admin / 7 motorista / login / rastreio público) + SW custom + i18n + E2E
docs/      → arquitetura detalhada
```

Deploy: veja `DEPLOY.md` (Render blueprint incluso via `render.yaml`).
