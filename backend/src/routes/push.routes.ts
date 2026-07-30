// ============================================================
// Web Push — registro de subscriptions (VAPID)
// ============================================================
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authRequired } from "../middleware/auth";
import { pushEnabled } from "../services/push";

const router = Router();

// Chave pública VAPID (necessária no frontend para subscrever)
router.get("/vapid-key", (_req, res) => {
  res.json({ enabled: pushEnabled(), publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
});

router.use(authRequired);

// POST /push/subscribe
router.post("/subscribe", async (req, res, next) => {
  try {
    const { endpoint, keys } = z
      .object({
        endpoint: z.string().url(),
        keys: z.object({ p256dh: z.string(), auth: z.string() }),
      })
      .parse(req.body);
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: req.user!.id, endpoint, keys },
      update: { userId: req.user!.id, keys },
    });
    res.status(201).json({ ok: true, id: sub.id });
  } catch (e) {
    next(e);
  }
});

// POST /push/unsubscribe
router.post("/unsubscribe", async (req, res, next) => {
  try {
    const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user!.id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
