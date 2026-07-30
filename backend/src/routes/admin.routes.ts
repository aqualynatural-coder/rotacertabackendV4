import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../utils/audit";

const router = Router();
router.use(authRequired, requireRole(Role.ADMIN));

// ============================================================
// POST /api/admin/reset — painel de limpeza seletiva
// EXIGE senha do admin logado (confirmação de segurança)
// Body: { password, deliveries?, routes?, customers?, customersTestOnly?,
//         notifications?, pings?, auditLogs?, driversInactiveOnly?,
//         reportsOlderThanDays? }
// ============================================================
router.post("/reset", async (req, res, next) => {
  try {
    const schema = z.object({
      password: z.string().min(1, "Senha do administrador é obrigatória"),
      deliveries: z.boolean().optional(),
      routes: z.boolean().optional(),
      customers: z.boolean().optional(),
      customersTestOnly: z.boolean().optional(),
      notifications: z.boolean().optional(),
      pings: z.boolean().optional(),
      auditLogs: z.boolean().optional(),
      driversInactiveOnly: z.boolean().optional(),
      reportsOlderThanDays: z.number().int().positive().optional(),
    });
    const data = schema.parse(req.body);

    // 1. Valida senha do admin
    const me = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!me) throw new HttpError(401, "Usuário não encontrado");
    const ok = await bcrypt.compare(data.password, me.passwordHash);
    if (!ok) throw new HttpError(403, "Senha incorreta — operação cancelada");

    const { password: _p, ...modules } = data;
    const nothing = !Object.values(modules).some((v) => !!v);
    if (nothing) throw new HttpError(400, "Selecione ao menos uma opção de limpeza");

    const deleted: Record<string, number> = {};

    await prisma.$transaction(async (tx) => {
      // Relatórios antigos = entregas finalizadas há mais de X dias
      if (data.reportsOlderThanDays) {
        const cutoff = new Date(Date.now() - data.reportsOlderThanDays * 86400_000);
        const old = await tx.delivery.findMany({
          where: {
            completedAt: { not: null, lt: cutoff },
            status: { in: ["COMPLETED", "FAILED", "CANCELED"] },
          },
          select: { id: true },
        });
        const ids = old.map((d) => d.id);
        await tx.proofOfDelivery.deleteMany({ where: { deliveryId: { in: ids } } });
        await tx.deliveryFailure.deleteMany({ where: { deliveryId: { in: ids } } });
        const d = await tx.delivery.deleteMany({ where: { id: { in: ids } } });
        deleted.oldReports = d.count;
      }

      // Entregas (todas) — também quando routes/customers forem zerados
      if (data.deliveries || data.routes || data.customers) {
        await tx.proofOfDelivery.deleteMany();
        await tx.deliveryFailure.deleteMany();
        const d = await tx.delivery.deleteMany();
        deleted.deliveries = d.count;
      }
      if (data.routes) {
        const r = await tx.route.deleteMany();
        deleted.routes = r.count;
      }
      if (data.customers) {
        const c = await tx.customer.deleteMany();
        deleted.customers = c.count;
      }
      // Apenas clientes de teste
      if (data.customersTestOnly && !data.customers) {
        const testCustomers = await tx.customer.findMany({
          where: { isTest: true },
          select: { id: true },
        });
        const cids = testCustomers.map((c) => c.id);
        const related = await tx.delivery.findMany({
          where: { customerId: { in: cids } },
          select: { id: true },
        });
        const dids = related.map((d) => d.id);
        await tx.proofOfDelivery.deleteMany({ where: { deliveryId: { in: dids } } });
        await tx.deliveryFailure.deleteMany({ where: { deliveryId: { in: dids } } });
        await tx.delivery.deleteMany({ where: { id: { in: dids } } });
        const c = await tx.customer.deleteMany({ where: { isTest: true } });
        deleted.testCustomers = c.count;
      }
      // Apenas motoristas inativos (apaga usuário + driver + vínculos)
      if (data.driversInactiveOnly) {
        const inactiveUsers = await tx.user.findMany({
          where: { role: "DRIVER", active: false },
          select: { id: true },
        });
        const uids = inactiveUsers.map((u) => u.id);
        const drivers = await tx.driver.findMany({
          where: { userId: { in: uids } },
          select: { id: true },
        });
        const drIds = drivers.map((d) => d.id);
        // desvincula entregas e rotas (não apaga histórico)
        await tx.delivery.updateMany({ where: { driverId: { in: drIds } }, data: { driverId: null } });
        await tx.route.updateMany({ where: { driverId: { in: drIds } }, data: { driverId: null } });
        await tx.locationPing.deleteMany({ where: { driverId: { in: drIds } } });
        const d = await tx.user.deleteMany({ where: { id: { in: uids } } });
        deleted.inactiveDrivers = d.count;
      }
      if (data.pings) {
        const p = await tx.locationPing.deleteMany();
        deleted.pings = p.count;
      }
      if (data.notifications) {
        const n = await tx.notification.deleteMany();
        deleted.notifications = n.count;
      }
      if (data.auditLogs) {
        const a = await tx.auditLog.deleteMany({
          where: { action: { not: "SYSTEM_RESET" } }, // preserva registros de reset
        });
        deleted.auditLogs = a.count;
      }
    });

    await audit({
      userId: req.user!.id,
      action: "SYSTEM_RESET",
      entity: "System",
      metadata: { modules, deleted },
      ip: req.ip,
    });

    res.json({ ok: true, deleted });
  } catch (e) {
    next(e);
  }
});

// ============================================================
// DELETE /api/admin/demo — apaga TODAS as contas de demonstração
// e seus dados vinculados (rotas demo, entregas, pings)
// ============================================================
router.delete("/demo", async (req, res, next) => {
  try {
    const demoUsers = await prisma.user.findMany({
      where: { isDemo: true },
      include: { driver: true },
    });
    if (demoUsers.length === 0) return res.json({ ok: true, deleted: 0 });

    const userIds = demoUsers.map((u) => u.id);
    const driverIds = demoUsers.filter((u) => u.driver).map((u) => u.driver!.id);

    await prisma.$transaction(async (tx) => {
      // Entregas/rotas dos motoristas demo
      const dels = await tx.delivery.findMany({
        where: { driverId: { in: driverIds } },
        select: { id: true },
      });
      const dids = dels.map((d) => d.id);
      await tx.proofOfDelivery.deleteMany({ where: { deliveryId: { in: dids } } });
      await tx.deliveryFailure.deleteMany({ where: { deliveryId: { in: dids } } });
      await tx.delivery.deleteMany({ where: { id: { in: dids } } });
      await tx.locationPing.deleteMany({ where: { driverId: { in: driverIds } } });
      await tx.route.deleteMany({ where: { driverId: { in: driverIds } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await tx.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });

    await audit({
      userId: req.user!.id,
      action: "DEMO_DATA_DELETED",
      entity: "System",
      metadata: { users: userIds.length },
      ip: req.ip,
    });

    res.json({ ok: true, deleted: demoUsers.length });
  } catch (e) {
    next(e);
  }
});

// GET /api/admin/demo — verifica se ainda existem contas demo
router.get("/demo", async (_req, res, next) => {
  try {
    const count = await prisma.user.count({ where: { isDemo: true } });
    res.json({ demoUsers: count });
  } catch (e) {
    next(e);
  }
});

export default router;
