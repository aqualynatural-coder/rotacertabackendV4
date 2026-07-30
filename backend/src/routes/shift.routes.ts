// ============================================================
// Expediente — check-in/check-out na sede (início/fim do dia)
// Automático via geofence (sockets) + manual (fallback)
// ============================================================
import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { haversineKm } from "../utils/logic";
import { pushToAdmins } from "../services/push";

const router = Router();
router.use(authRequired);

function todayKey(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Verifica se coordenada está dentro do geofence da sede
async function isInsideHQ(lat: number, lng: number): Promise<boolean> {
  const s = await prisma.systemSettings.findUnique({ where: { id: "settings" } });
  if (!s?.hqLatitude || !s?.hqLongitude) return false;
  const distKm = haversineKm(lat, lng, s.hqLatitude, s.hqLongitude);
  return distKm * 1000 <= (s.hqRadiusM ?? 150);
}

// Helper central — usado também pelos sockets (auto check-in/out)
export async function doCheckIn(driverId: string, lat?: number, lng?: number, auto = false) {
  const date = todayKey();
  const existing = await prisma.shift.findUnique({
    where: { driverId_date: { driverId, date } },
  });
  if (existing?.checkInAt) return { shift: existing, created: false };
  const shift = existing
    ? await prisma.shift.update({
        where: { id: existing.id },
        data: { checkInAt: new Date(), checkInLat: lat, checkInLng: lng, autoCheckIn: auto },
      })
    : await prisma.shift.create({
        data: { driverId, date, checkInAt: new Date(), checkInLat: lat, checkInLng: lng, autoCheckIn: auto },
      });
  return { shift, created: true };
}

export async function doCheckOut(driverId: string, lat?: number, lng?: number, auto = false) {
  const date = todayKey();
  const existing = await prisma.shift.findUnique({
    where: { driverId_date: { driverId, date } },
  });
  if (!existing || existing.checkOutAt) return { shift: existing, created: false };
  const shift = await prisma.shift.update({
    where: { id: existing.id },
    data: { checkOutAt: new Date(), checkOutLat: lat, checkOutLng: lng, autoCheckOut: auto },
  });
  return { shift, created: true };
}

// GET /shifts/me — expediente de hoje do motorista logado
router.get("/me", async (req, res, next) => {
  try {
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) throw new HttpError(403, "Somente motoristas");
    const shift = await prisma.shift.findUnique({
      where: { driverId_date: { driverId: driver.id, date: todayKey() } },
    });
    res.json(shift ?? null);
  } catch (e) {
    next(e);
  }
});

// POST /shifts/check-in — início do expediente (manual, com GPS)
router.post("/check-in", async (req, res, next) => {
  try {
    const { latitude, longitude } = z
      .object({ latitude: z.number().optional(), longitude: z.number().optional() })
      .parse(req.body ?? {});
    const driver = await prisma.driver.findFirst({
      where: { userId: req.user!.id },
      include: { user: true },
    });
    if (!driver) throw new HttpError(403, "Somente motoristas");

    const { shift, created } = await doCheckIn(driver.id, latitude, longitude, false);
    if (created) {
      const io = req.app.get("io");
      io?.to("admin").emit("shift:started", {
        driverId: driver.id, name: driver.user.name, at: shift.checkInAt, manual: true,
      });
      await prisma.notification.create({
        data: {
          userId: req.user!.id, type: "SHIFT_STARTED",
          title: "Expediente iniciado",
          body: `${driver.user.name} iniciou o expediente às ${new Date().toLocaleTimeString("pt-BR")}`,
        },
      });
      pushToAdmins({ title: "🌅 Expediente iniciado", body: `${driver.user.name} começou a trabalhar`, tag: "shift" });
    }
    res.json(shift);
  } catch (e) {
    next(e);
  }
});

// POST /shifts/check-out — fim do expediente (manual, com GPS)
router.post("/check-out", async (req, res, next) => {
  try {
    const { latitude, longitude } = z
      .object({ latitude: z.number().optional(), longitude: z.number().optional() })
      .parse(req.body ?? {});
    const driver = await prisma.driver.findFirst({
      where: { userId: req.user!.id },
      include: { user: true },
    });
    if (!driver) throw new HttpError(403, "Somente motoristas");

    const { shift, created } = await doCheckOut(driver.id, latitude, longitude, false);
    if (created && shift) {
      const io = req.app.get("io");
      io?.to("admin").emit("shift:ended", {
        driverId: driver.id, name: driver.user.name, at: shift!.checkOutAt, manual: true,
      });
      pushToAdmins({ title: "🏁 Expediente encerrado", body: `${driver.user.name} voltou para a empresa`, tag: "shift" });
    }
    res.json(shift);
  } catch (e) {
    next(e);
  }
});

// GET /shifts — histórico (admin vê tudo, motorista vê o próprio)
router.get("/", async (req, res, next) => {
  try {
    const days = Math.min(90, Number(req.query.days) || 30);
    const since = new Date(Date.now() - days * 86400_000);
    const where: any = { date: { gte: since } };
    if (req.user!.role === Role.DRIVER) {
      const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
      where.driverId = driver?.id;
    }
    const shifts = await prisma.shift.findMany({
      where,
      include: { driver: { include: { user: { select: { name: true } } } } },
      orderBy: { date: "desc" },
    });
    res.json(shifts);
  } catch (e) {
    next(e);
  }
});

// GET /shifts/today — visão do admin: quem está em expediente hoje
router.get("/today", requireRole(Role.ADMIN), async (_req, res, next) => {
  try {
    const shifts = await prisma.shift.findMany({
      where: { date: todayKey() },
      include: { driver: { include: { user: { select: { name: true, avatarUrl: true } } } } },
    });
    res.json(shifts);
  } catch (e) {
    next(e);
  }
});

export { isInsideHQ, todayKey };
export default router;
