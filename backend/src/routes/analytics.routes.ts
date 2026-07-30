import { Router } from "express";
import { Role, DeliveryStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired } from "../middleware/auth";
import { compareTimeMessage } from "../utils/logic";
import { startOfDay, subDays, differenceInMinutes } from "date-fns";

const router = Router();
router.use(authRequired);

// GET /analytics/driver/me — gamificação e produtividade do motorista logado
router.get("/driver/me", async (req, res, next) => {
  try {
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) return res.json({ weekly: [], motivational: null, totalKm: 0 });

    const today = startOfDay(new Date());

    // Entregas concluídas nos últimos 7 dias
    const sevenDaysAgo = subDays(today, 6);
    const completed = await prisma.delivery.findMany({
      where: {
        driverId: driver.id,
        status: DeliveryStatus.COMPLETED,
        completedAt: { gte: sevenDaysAgo },
      },
      select: { completedAt: true },
    });

    // Agrupa por dia
    const weekly: { date: string; day: string; count: number }[] = [];
    const dayNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
    for (let i = 6; i >= 0; i--) {
      const d = subDays(today, i);
      const key = d.toISOString().slice(0, 10);
      const count = completed.filter(
        (c) => c.completedAt && c.completedAt.toISOString().slice(0, 10) === key
      ).length;
      weekly.push({ date: key, day: dayNames[d.getDay()], count });
    }

    // Tempo médio por entrega hoje vs média histórica
    const todayDeliveries = await prisma.delivery.findMany({
      where: {
        driverId: driver.id,
        status: DeliveryStatus.COMPLETED,
        completedAt: { gte: today },
        arrivedAt: { not: null },
      },
      select: { arrivedAt: true, completedAt: true },
    });
    const historyDeliveries = await prisma.delivery.findMany({
      where: {
        driverId: driver.id,
        status: DeliveryStatus.COMPLETED,
        completedAt: { lt: today },
        arrivedAt: { not: null },
      },
      select: { arrivedAt: true, completedAt: true },
      take: 50,
    });

    const avg = (arr: { arrivedAt: Date | null; completedAt: Date | null }[]) => {
      const times = arr
        .filter((d) => d.arrivedAt && d.completedAt)
        .map((d) => differenceInMinutes(d.completedAt!, d.arrivedAt!));
      if (times.length === 0) return null;
      return times.reduce((a, b) => a + b, 0) / times.length;
    };

    const todayAvg = avg(todayDeliveries);
    const historyAvg = avg(historyDeliveries);
    const motivational =
      todayAvg != null && historyAvg != null
        ? compareTimeMessage(todayAvg, historyAvg)
        : null;

    res.json({
      weekly,
      motivational,
      todayAvgMinutes: todayAvg,
      historyAvgMinutes: historyAvg,
      totalKm: driver.totalKmDriven,
    });
  } catch (e) {
    next(e);
  }
});

// GET /analytics/admin/delayed — entregas atrasadas agora (para o dashboard)
router.get("/admin/delayed", async (req, res, next) => {
  try {
    if (req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "Acesso negado" });
    const now = new Date();
    const pending = await prisma.delivery.findMany({
      where: {
        status: { in: [DeliveryStatus.ASSIGNED, DeliveryStatus.IN_TRANSIT] },
        scheduledAt: { not: null, lt: now },
      },
      include: {
        customer: true,
        driver: { include: { user: { select: { name: true } } } },
      },
    });
    const withDelay = pending.map((d) => {
      const diffMin = d.scheduledAt
        ? Math.round((now.getTime() - d.scheduledAt.getTime()) / 60_000)
        : 0;
      return {
        id: d.id,
        customer: d.customer.name,
        address: d.customer.address,
        driver: d.driver?.user.name ?? "—",
        scheduledAt: d.scheduledAt,
        delayMinutes: diffMin,
        level: diffMin > 30 ? "critical" : diffMin > 10 ? "attention" : "on_time",
      };
    });
    res.json(withDelay);
  } catch (e) {
    next(e);
  }
});

export default router;
