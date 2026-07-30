import { Router } from "express";
import { Role, DeliveryStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";

const router = Router();
router.use(authRequired, requireRole(Role.ADMIN));

// Resumo geral do dashboard
router.get("/summary", async (_req, res, next) => {
  try {
    const [total, pending, completed, failed, inTransit, driversActive] = await Promise.all([
      prisma.delivery.count(),
      prisma.delivery.count({ where: { status: { in: [DeliveryStatus.PENDING, DeliveryStatus.ASSIGNED] } } }),
      prisma.delivery.count({ where: { status: DeliveryStatus.COMPLETED } }),
      prisma.delivery.count({ where: { status: DeliveryStatus.FAILED } }),
      prisma.delivery.count({ where: { status: { in: [DeliveryStatus.IN_TRANSIT, DeliveryStatus.ARRIVED] } } }),
      prisma.route.count({ where: { status: "ACTIVE" } }),
    ]);
    res.json({ total, pending, completed, failed, inTransit, driversActive });
  } catch (e) {
    next(e);
  }
});

// Relatório por motorista
router.get("/driver/:id", async (req, res, next) => {
  try {
    const deliveries = await prisma.delivery.findMany({
      where: { driverId: req.params.id },
      include: { customer: true, proof: true, failure: true },
      orderBy: { createdAt: "desc" },
    });
    const total = deliveries.length;
    const completed = deliveries.filter((d) => d.status === "COMPLETED").length;
    const failed = deliveries.filter((d) => d.status === "FAILED").length;
    res.json({ total, completed, failed, deliveries });
  } catch (e) {
    next(e);
  }
});

// Relatório por período
router.get("/period", async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86400_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();

    const deliveries = await prisma.delivery.findMany({
      where: { createdAt: { gte: from, lte: to } },
      include: { customer: true, driver: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ from, to, count: deliveries.length, deliveries });
  } catch (e) {
    next(e);
  }
});

// Relatório por cliente
router.get("/customer/:id", async (req, res, next) => {
  try {
    const list = await prisma.delivery.findMany({
      where: { customerId: req.params.id },
      include: { driver: { include: { user: true } }, proof: true, failure: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(list);
  } catch (e) {
    next(e);
  }
});

export default router;
