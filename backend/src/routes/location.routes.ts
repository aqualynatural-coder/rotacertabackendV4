import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { detectGpsSpoof } from "../utils/logic";

const router = Router();
router.use(authRequired);

const pingSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  speed: z.number().optional(),
  heading: z.number().optional(),
  accuracy: z.number().optional(),
  recordedAt: z.string().datetime().optional(),
  routeId: z.string().optional(),
});

// Motorista envia ping (unitário)
router.post("/ping", async (req, res, next) => {
  try {
    const data = pingSchema.parse(req.body);
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) return res.status(400).json({ error: "Somente motoristas podem enviar ping" });

    const recordedAt = data.recordedAt ? new Date(data.recordedAt) : new Date();
    // Anti-spoof também no caminho REST (sync offline)
    const lastPing = await prisma.locationPing.findFirst({
      where: { driverId: driver.id },
      orderBy: { recordedAt: "desc" },
    });
    const spoof = detectGpsSpoof(
      { latitude: data.latitude, longitude: data.longitude, speed: data.speed ?? null, accuracy: data.accuracy ?? null, recordedAt },
      lastPing ? { latitude: lastPing.latitude, longitude: lastPing.longitude, speed: lastPing.speed, accuracy: lastPing.accuracy, recordedAt: lastPing.recordedAt } : null
    );

    const ping = await prisma.locationPing.create({
      data: {
        driverId: driver.id,
        routeId: data.routeId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed,
        heading: data.heading,
        accuracy: data.accuracy,
        suspect: spoof.suspect,
        suspectReason: spoof.reason ?? null,
        recordedAt,
      },
    });

    const io = req.app.get("io");
    io?.to("admin").emit("driver:location", {
      driverId: driver.id,
      latitude: ping.latitude,
      longitude: ping.longitude,
      speed: ping.speed,
      heading: ping.heading,
      recordedAt: ping.recordedAt,
    });

    res.status(201).json(ping);
  } catch (e) {
    next(e);
  }
});

// Envio em lote (sincronização offline)
router.post("/ping/batch", async (req, res, next) => {
  try {
    const schema = z.object({ pings: z.array(pingSchema) });
    const { pings } = schema.parse(req.body);
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) return res.status(400).json({ error: "Somente motoristas podem enviar ping" });

    const created = await prisma.locationPing.createMany({
      data: pings.map((p) => ({
        driverId: driver.id,
        routeId: p.routeId,
        latitude: p.latitude,
        longitude: p.longitude,
        speed: p.speed,
        heading: p.heading,
        accuracy: p.accuracy,
        recordedAt: p.recordedAt ? new Date(p.recordedAt) : new Date(),
      })),
    });

    res.json({ inserted: created.count });
  } catch (e) {
    next(e);
  }
});

// Última localização de cada motorista ativo
router.get("/live", requireRole(Role.ADMIN), async (_req, res, next) => {
  try {
    const drivers = await prisma.driver.findMany({
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        pings: { orderBy: { recordedAt: "desc" }, take: 1 },
      },
    });
    const result = drivers
      .filter((d) => d.pings.length > 0)
      .map((d) => ({
        driverId: d.id,
        name: d.user.name,
        avatarUrl: d.user.avatarUrl,
        vehiclePlate: d.vehiclePlate,
        latitude: d.pings[0].latitude,
        longitude: d.pings[0].longitude,
        speed: d.pings[0].speed,
        heading: d.pings[0].heading,
        recordedAt: d.pings[0].recordedAt,
      }));
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Heatmap — pontos agregados para o mapa de calor (admin)
router.get("/heat", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const days = Math.min(90, Number(req.query.days) || 30);
    const since = new Date(Date.now() - days * 86400_000);
    const pings = await prisma.locationPing.findMany({
      where: { recordedAt: { gte: since } },
      select: { latitude: true, longitude: true, suspect: true },
      orderBy: { recordedAt: "desc" },
      take: 5000,
    });
    res.json(pings.map((p) => [p.latitude, p.longitude, p.suspect ? 1.5 : 0.6]));
  } catch (e) {
    next(e);
  }
});

// Trajeto por rota
router.get("/route/:routeId", async (req, res, next) => {
  try {
    const pings = await prisma.locationPing.findMany({
      where: { routeId: req.params.routeId },
      orderBy: { recordedAt: "asc" },
    });
    res.json(pings);
  } catch (e) {
    next(e);
  }
});

export default router;
