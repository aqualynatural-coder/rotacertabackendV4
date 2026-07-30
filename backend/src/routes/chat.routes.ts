// ============================================================
// Chat escritório <-> motorista (histórico REST + tempo real via socket)
// ============================================================
import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

const router = Router();
router.use(authRequired);

// GET /chat/threads — admin: lista motoristas com última mensagem + não lidas
router.get("/threads", requireRole(Role.ADMIN), async (_req, res, next) => {
  try {
    const drivers = await prisma.driver.findMany({
      include: { user: { select: { id: true, name: true, avatarUrl: true, active: true } } },
    });
    const threads = await Promise.all(
      drivers.map(async (d) => {
        const last = await prisma.chatMessage.findFirst({
          where: { driverId: d.id },
          orderBy: { createdAt: "desc" },
        });
        const unread = await prisma.chatMessage.count({
          where: { driverId: d.id, senderRole: "DRIVER", read: false },
        });
        return {
          driverId: d.id,
          name: d.user.name,
          avatarUrl: d.user.avatarUrl,
          active: d.user.active,
          lastMessage: last?.body ?? null,
          lastAt: last?.createdAt ?? null,
          unread,
        };
      })
    );
    threads.sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
    res.json(threads);
  } catch (e) {
    next(e);
  }
});

// GET /chat/messages?driverId= — histórico (admin informa driverId; motorista usa o próprio)
router.get("/messages", async (req, res, next) => {
  try {
    let driverId = String(req.query.driverId ?? "");
    if (req.user!.role === Role.DRIVER) {
      const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
      if (!driver) throw new HttpError(403, "Somente motoristas");
      driverId = driver.id;
    } else if (!driverId) {
      throw new HttpError(400, "driverId obrigatório");
    }
    const messages = await prisma.chatMessage.findMany({
      where: { driverId },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    // Marca como lidas as mensagens do outro lado
    const senderRoleToMark = req.user!.role === Role.ADMIN ? "DRIVER" : "ADMIN";
    await prisma.chatMessage.updateMany({
      where: { driverId, senderRole: senderRoleToMark, read: false },
      data: { read: true },
    });
    res.json(messages);
  } catch (e) {
    next(e);
  }
});

// POST /chat/messages — fallback REST (o caminho principal é o socket)
router.post("/messages", async (req, res, next) => {
  try {
    const { driverId: rawDriverId, body } = z
      .object({ driverId: z.string().optional(), body: z.string().min(1).max(1000) })
      .parse(req.body);

    let driverId = rawDriverId ?? "";
    if (req.user!.role === Role.DRIVER) {
      const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
      if (!driver) throw new HttpError(403, "Somente motoristas");
      driverId = driver.id;
    } else if (!driverId) {
      throw new HttpError(400, "driverId obrigatório");
    }

    const msg = await prisma.chatMessage.create({
      data: { driverId, senderId: req.user!.id, senderRole: req.user!.role, body },
    });

    const io = req.app.get("io");
    io?.to("admin").emit("chat:message", msg);
    io?.to(`driver:${driverId}`).emit("chat:message", msg);

    res.status(201).json(msg);
  } catch (e) {
    next(e);
  }
});

// GET /chat/unread — badge de não lidas do motorista logado
router.get("/unread", async (req, res, next) => {
  try {
    let count = 0;
    if (req.user!.role === Role.DRIVER) {
      const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
      if (driver) {
        count = await prisma.chatMessage.count({
          where: { driverId: driver.id, senderRole: "ADMIN", read: false },
        });
      }
    } else {
      count = await prisma.chatMessage.count({
        where: { senderRole: "DRIVER", read: false },
      });
    }
    res.json({ unread: count });
  } catch (e) {
    next(e);
  }
});

export default router;
