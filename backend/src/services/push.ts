// ============================================================
// Web Push (VAPID) — notificação mesmo com o app fechado
// Chaves via env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
// Gere com: npx web-push generate-vapid-keys
// ============================================================
import webpush from "web-push";
import { prisma } from "../lib/prisma";

const pub = process.env.VAPID_PUBLIC_KEY;
const priv = process.env.VAPID_PRIVATE_KEY;

let ready = false;
if (pub && priv) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:contato@rotacerta.app",
    pub,
    priv
  );
  ready = true;
} else {
  console.warn("⚠️  VAPID keys ausentes — Web Push desabilitado (defina VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)");
}

export function pushEnabled() {
  return ready;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

// Envia push para todas as subscriptions de um usuário
export async function pushToUser(userId: string, payload: PushPayload) {
  if (!ready) return { sent: 0 };
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  for (const s of subs) {
    try {
      const keys = s.keys as { p256dh: string; auth: string };
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys },
        JSON.stringify(payload),
        { TTL: 3600 }
      );
      sent++;
    } catch (e: any) {
      // Subscription expirada (404/410) → remove
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => null);
      }
    }
  }
  return { sent };
}

// Envia push para todos os admins
export async function pushToAdmins(payload: PushPayload) {
  if (!ready) return { sent: 0 };
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", active: true }, select: { id: true } });
  let sent = 0;
  for (const a of admins) {
    sent += (await pushToUser(a.id, payload)).sent;
  }
  return { sent };
}
