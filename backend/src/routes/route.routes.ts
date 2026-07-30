import { Router } from "express";
import { z } from "zod";
import { Role, RouteStatus, DeliveryStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../utils/audit";
import { totalDistanceKm, fuelUsedLiters, fuelCostBrl, needsMaintenance, optimizeRouteOrder, estimateRouteKm } from "../utils/logic";
import { AlertType } from "@prisma/client";

const router = Router();
router.use(authRequired);

router.get("/", async (req, res, next) => {
  try {
    const where: any = {};
    if (req.user!.role === Role.DRIVER) {
      const d = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
      if (!d) return res.json([]);
      where.driverId = d.id;
    }
    const list = await prisma.route.findMany({
      where,
      include: {
        driver: { include: { user: { select: { id: true, name: true } } } },
        deliveries: { include: { customer: true }, orderBy: { sequence: "asc" } },
      },
      orderBy: { scheduledFor: "desc" },
    });
    res.json(list);
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const r = await prisma.route.findUnique({
      where: { id: req.params.id },
      include: {
        driver: { include: { user: true } },
        deliveries: { include: { customer: true, proof: true, failure: true }, orderBy: { sequence: "asc" } },
        pings: { orderBy: { recordedAt: "asc" }, take: 500 },
      },
    });
    if (!r) throw new HttpError(404, "Rota não encontrada");
    res.json(r);
  } catch (e) {
    next(e);
  }
});

const createSchema = z.object({
  name: z.string().min(2),
  driverId: z.string().optional(),
  scheduledFor: z.string().datetime(),
  deliveries: z
    .array(
      z.object({
        customerId: z.string(),
        scheduledAt: z.string().datetime().optional(),
        notes: z.string().optional(),
      })
    )
    .optional(),
});

router.post("/", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const r = await prisma.route.create({
      data: {
        name: data.name,
        driverId: data.driverId,
        scheduledFor: new Date(data.scheduledFor),
        deliveries: data.deliveries
          ? {
              create: data.deliveries.map((d, i) => ({
                customerId: d.customerId,
                driverId: data.driverId,
                sequence: i + 1,
                status: data.driverId ? DeliveryStatus.ASSIGNED : DeliveryStatus.PENDING,
                scheduledAt: d.scheduledAt ? new Date(d.scheduledAt) : null,
                notes: d.notes,
              })),
            }
          : undefined,
      },
      include: { deliveries: { include: { customer: true } } },
    });

    await audit({ userId: req.user!.id, action: "ROUTE_CREATED", entity: "Route", entityId: r.id });

    // Notifica motorista
    const io = req.app.get("io");
    if (data.driverId) io?.to(`driver:${data.driverId}`).emit("delivery:assigned", { routeId: r.id });

    res.status(201).json(r);
  } catch (e) {
    next(e);
  }
});

// POST /:id/optimize — reordena entregas minimizando km (nearest neighbor, sem API paga)
router.post("/:id/optimize", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const route = await prisma.route.findUnique({
      where: { id: req.params.id },
      include: { deliveries: { include: { customer: true } } },
    });
    if (!route) throw new HttpError(404, "Rota não encontrada");
    const open = route.deliveries.filter(
      (d) => ![DeliveryStatus.COMPLETED, DeliveryStatus.FAILED, DeliveryStatus.CANCELED].includes(d.status)
    );
    if (open.length < 3) throw new HttpError(400, "São necessárias pelo menos 3 entregas abertas para otimizar");

    const settings = await prisma.systemSettings.findUnique({ where: { id: "settings" } }, );
    const start = settings?.hqLatitude != null && settings?.hqLongitude != null
      ? { latitude: settings.hqLatitude, longitude: settings.hqLongitude }
      : null;

    const beforeKm = estimateRouteKm(open.map((d) => d.customer), start);
    const ordered = optimizeRouteOrder(
      open.map((d) => ({ id: d.id, latitude: d.customer.latitude, longitude: d.customer.longitude })),
      start
    );
    const afterKm = estimateRouteKm(ordered, start);

    // Reatribui sequence mantendo as finalizadas no início
    const done = route.deliveries.filter((d) => !open.find((o) => o.id === d.id));
    let seq = done.length;
    for (const o of ordered) {
      seq++;
      await prisma.delivery.update({ where: { id: o.id }, data: { sequence: seq } });
    }

    await audit({ userId: req.user!.id, action: "ROUTE_OPTIMIZED", entity: "Route", entityId: route.id, metadata: { beforeKm, afterKm } });
    const io = req.app.get("io");
    if (route.driverId) io?.to(`driver:${route.driverId}`).emit("route:optimized", { routeId: route.id });

    res.json({
      ok: true,
      beforeKm: Math.round(beforeKm * 10) / 10,
      afterKm: Math.round(afterKm * 10) / 10,
      savedKm: Math.round((beforeKm - afterKm) * 10) / 10,
      order: ordered.map((o) => o.id),
    });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/start", async (req, res, next) => {
  try {
    const r = await prisma.route.update({
      where: { id: req.params.id },
      data: { status: RouteStatus.ACTIVE, startedAt: new Date() },
    });
    const io = req.app.get("io");
    io?.emit("route:started", { routeId: r.id, driverId: r.driverId });
    await audit({ userId: req.user!.id, action: "ROUTE_STARTED", entity: "Route", entityId: r.id });
    res.json(r);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/end", async (req, res, next) => {
  try {
    // 1. Busca pings do trajeto para calcular distância real
    const pings = await prisma.locationPing.findMany({
      where: { routeId: req.params.id },
      orderBy: { recordedAt: "asc" },
    });
    const distanceKm = totalDistanceKm(pings);

    // 2. Busca o veículo do motorista para calcular combustível
    const route = await prisma.route.findUnique({ where: { id: req.params.id } });
    let liters = 0;
    let cost = 0;
    if (route?.driverId) {
      const vehicle = await prisma.vehicle.findUnique({ where: { driverId: route.driverId } });
      if (vehicle && distanceKm > 0) {
        liters = fuelUsedLiters(distanceKm, vehicle.fuelConsumptionKmL);
        cost = fuelCostBrl(liters, vehicle.fuelPricePerLiter);
        // 3. Atualiza quilometragem do veículo e do motorista
        await prisma.vehicle.update({
          where: { driverId: route.driverId },
          data: { kmSinceMaintenance: { increment: distanceKm } },
        });
        await prisma.driver.update({
          where: { id: route.driverId },
          data: { totalKmDriven: { increment: distanceKm } },
        });
        // 4. Verifica manutenção preventiva
        const updated = await prisma.vehicle.findUnique({ where: { driverId: route.driverId } });
        if (updated && needsMaintenance(updated.kmSinceMaintenance, updated.maintenanceKmLimit)) {
          const io2 = req.app.get("io");
          io2?.to("admin").emit("alert:maintenance", {
            vehicleId: updated.id,
            plate: updated.plate,
            km: updated.kmSinceMaintenance,
          });
        }
      }
    }

    // 5. Finaliza rota com métricas calculadas
    const r = await prisma.route.update({
      where: { id: req.params.id },
      data: {
        status: RouteStatus.COMPLETED,
        endedAt: new Date(),
        distanceKm,
        fuelUsedLiters: liters,
        fuelCostBrl: cost,
      },
    });

    const io = req.app.get("io");
    io?.emit("route:ended", { routeId: r.id, driverId: r.driverId, distanceKm, fuelCostBrl: cost });
    res.json(r);
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    await prisma.route.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
