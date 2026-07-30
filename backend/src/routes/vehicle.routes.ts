import { Router } from "express";
import { z } from "zod";
import { Role, AlertType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { needsMaintenance } from "../utils/logic";

const router = Router();
router.use(authRequired);

const vehicleSchema = z.object({
  plate: z.string().min(3),
  model: z.string().min(1),
  fuelConsumptionKmL: z.number().positive(),
  fuelPricePerLiter: z.number().positive(),
  maintenanceKmLimit: z.number().positive().optional(),
});

// GET /vehicles/me — motorista vê seu veículo
router.get("/me", async (req, res, next) => {
  try {
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) return res.json(null);
    const v = await prisma.vehicle.findUnique({ where: { driverId: driver.id } });
    res.json(v);
  } catch (e) {
    next(e);
  }
});

// GET /vehicles/driver/:id — admin consulta veículo do motorista
router.get("/driver/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const v = await prisma.vehicle.findUnique({
      where: { driverId: req.params.id },
      include: { driver: { include: { user: { select: { name: true } } } } },
    });
    if (!v) throw new HttpError(404, "Veículo não cadastrado para este motorista");
    res.json({ ...v, needsMaintenance: needsMaintenance(v.kmSinceMaintenance, v.maintenanceKmLimit) });
  } catch (e) {
    next(e);
  }
});

// PUT /vehicles/driver/:id — admin cria/atualiza veículo do motorista
router.put("/driver/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const data = vehicleSchema.parse(req.body);
    const v = await prisma.vehicle.upsert({
      where: { driverId: req.params.id },
      create: { driverId: req.params.id, ...data },
      update: data,
    });
    res.json(v);
  } catch (e) {
    next(e);
  }
});

// POST /vehicles/:id/maintenance-done — zera contador após revisão
router.post("/:id/maintenance-done", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const v = await prisma.vehicle.update({
      where: { id: req.params.id },
      data: { kmSinceMaintenance: 0 },
    });
    res.json(v);
  } catch (e) {
    next(e);
  }
});

// GET /vehicles/alerts — admin: lista veículos que precisam de revisão
router.get("/alerts/maintenance", requireRole(Role.ADMIN), async (_req, res, next) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      include: { driver: { include: { user: { select: { name: true } } } } },
    });
    const alerts = vehicles
      .filter((v) => needsMaintenance(v.kmSinceMaintenance, v.maintenanceKmLimit))
      .map((v) => ({
        vehicleId: v.id,
        plate: v.plate,
        model: v.model,
        driverName: v.driver.user.name,
        kmSinceMaintenance: v.kmSinceMaintenance,
        maintenanceKmLimit: v.maintenanceKmLimit,
        exceededKm: v.kmSinceMaintenance - v.maintenanceKmLimit,
      }));
    res.json(alerts);
  } catch (e) {
    next(e);
  }
});

export default router;
